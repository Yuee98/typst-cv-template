// @vitest-environment jsdom
/**
 * Async-ownership race tests for usePolishFlow (relay round 1): the pure
 * reducer tests cannot reach these — they need a hook harness with deferred
 * promises and controllable form/session/document/language values.
 *
 * Covered invariants:
 * - terms-acceptance window: close / unmount / document switch / param or
 *   form change during accept() → NO polish request is ever sent;
 * - in-flight ownership: cancel A → start B → A's late settle (success /
 *   403 / network error) never disturbs B's controller, quota, terms or
 *   reducer state;
 * - snapshot identity: document + request language + reference path values
 *   are write-back barriers, not after-the-fact warnings; undo-accept stays
 *   available under reference drift;
 * - account keying: terms/quota state never leaks across session.user.id;
 * - cancel discards the quota display and blocks confirm until the re-read
 *   fired from the canceled request's settlement point completes.
 */

import type { Session } from "@supabase/supabase-js";
import { act, cleanup, render } from "@testing-library/react";
import { createRef, useImperativeHandle, type RefObject } from "react";
import { useForm, type UseFormReturn } from "react-hook-form";
import { afterEach, describe, expect, it, vi } from "vitest";

import { DEFAULT_SECTION_ORDER, ORDERED_SECTION_IDS, type CvData } from "@/lib/cv/schema";
import type {
  PolishLanguage,
  PolishQuota,
  PolishQuotaResponse,
  PolishRequest,
  PolishSuccessResponse,
} from "@/lib/polish/contract";

import { PolishApiError, type PolishApiClient } from "./polish-client";
import { POLISH_TRANSPORT_ERROR_CODES } from "./polish-errors";
import type { PolishScope } from "./scope-builder";
import {
  usePolishFlow,
  type PolishFlow,
  type PolishTermsGateway,
} from "./use-polish-flow";

afterEach(() => {
  cleanup();
});

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

const SCOPE: PolishScope = { sectionId: "skills", granularity: "section" };

function bullet(body: string) {
  return { body };
}

function makeCvData(): CvData {
  return {
    schemaVersion: 7,
    typstLang: "zh",
    sectionOrder: [...DEFAULT_SECTION_ORDER],
    header: {
      name: "张三",
      subtitle: "",
      email: "zhangsan@example.com",
      phone: "13800000000",
      selfName: "",
    },
    sectionTitles: Object.fromEntries(
      ORDERED_SECTION_IDS.map((id) => [
        id,
        { title: `${id} title`, isDisplay: true, pageBreakBefore: false },
      ]),
    ) as CvData["sectionTitles"],
    profile: [bullet("五年后端开发经验，专注高并发分布式系统。")],
    skills: [
      { label: "编程语言", body: "TypeScript、Go、Rust，熟悉函数式编程范式。" },
      { label: "框架", body: "React、Next.js、NestJS，有大型项目实战经验。" },
    ],
    experience: [
      {
        org: "阿里巴巴",
        date: "2020-2023",
        projects: [
          {
            title: "订单中台",
            detail: "核心交易链路重构",
            date: "2021-2023",
            bullets: [bullet("主导订单系统重构，支撑双 11 峰值每秒 50 万笔下单。")],
          },
        ],
      },
    ],
    education: [
      {
        org: "清华大学",
        title: "计算机科学与技术 硕士",
        detail: "分布式系统方向",
        date: "2015-2018",
        bullets: [bullet("研究分布式一致性协议，发表 OSDI 论文一篇。")],
      },
    ],
    research: [
      {
        title: "分布式存储副本协议",
        date: "2017",
        bullets: [bullet("提出改进的副本同步协议，写入吞吐提升 30%。")],
      },
    ],
    publications: [
      { authors: "张三", title: "A Paper", venue: "OSDI", year: "2018", url: "https://example.com" },
    ],
    additional: [{ label: "语言", body: "英语流利（CET-6），可作为工作语言。" }],
  };
}

function makeSession(userId: string): Session {
  return {
    user: { id: userId },
    access_token: `token-${userId}`,
  } as unknown as Session;
}

function makeQuota(remaining: number): PolishQuota {
  return { limit: 20, remaining, resetAt: "2026-08-04T00:00:00Z" };
}

// ---------------------------------------------------------------------------
// deferred promises + controllable client/terms doubles
// ---------------------------------------------------------------------------

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function makeClient() {
  const polishCalls: Array<{ request: PolishRequest; deferred: Deferred<PolishSuccessResponse> }> =
    [];
  const quotaCalls: Array<Deferred<PolishQuotaResponse>> = [];
  const client: PolishApiClient = {
    polish: vi.fn((request: PolishRequest) => {
      const call = deferred<PolishSuccessResponse>();
      polishCalls.push({ request, deferred: call });
      return call.promise;
    }),
    getQuota: vi.fn(() => {
      const call = deferred<PolishQuotaResponse>();
      quotaCalls.push(call);
      return call.promise;
    }),
  };
  return { client, polishCalls, quotaCalls };
}

function makeTermsGateway() {
  const hasAcceptedCalls: Array<Deferred<boolean>> = [];
  const acceptCalls: Array<Deferred<void>> = [];
  const termsGateway: PolishTermsGateway = {
    hasAccepted: vi.fn(() => {
      const call = deferred<boolean>();
      hasAcceptedCalls.push(call);
      return call.promise;
    }),
    accept: vi.fn(() => {
      const call = deferred<void>();
      acceptCalls.push(call);
      return call.promise;
    }),
  };
  return { termsGateway, hasAcceptedCalls, acceptCalls };
}

function successResponse(
  request: PolishRequest,
  remaining: number,
  requestId = "srv-req-1",
): PolishSuccessResponse {
  return {
    requestId,
    items: request.items.map((item) => ({ id: item.id, polished: `润色：${item.text}` })),
    quota: makeQuota(remaining),
  };
}

function abortError(): PolishApiError {
  return new PolishApiError({ code: POLISH_TRANSPORT_ERROR_CODES.requestAborted });
}

// ---------------------------------------------------------------------------
// harness
// ---------------------------------------------------------------------------

interface HarnessHandle {
  flow: PolishFlow | null;
  form: UseFormReturn<CvData> | null;
}

interface HarnessProps {
  handleRef: RefObject<HarnessHandle | null>;
  documentId: string | null;
  language: PolishLanguage;
  session: Session | null;
  client: PolishApiClient;
  termsGateway: PolishTermsGateway;
}

function Harness({
  handleRef,
  documentId,
  language,
  session,
  client,
  termsGateway,
}: HarnessProps) {
  const form = useForm<CvData>({ defaultValues: makeCvData() });
  const flow = usePolishFlow({
    form,
    documentId,
    language,
    session,
    supabase: null,
    client,
    termsGateway,
  });
  useImperativeHandle(handleRef, () => ({ flow, form }));
  return null;
}

function renderHarness(overrides?: Partial<Omit<HarnessProps, "handleRef">>) {
  const handleRef = createRef<HarnessHandle>();
  const { client, polishCalls, quotaCalls } = makeClient();
  const { termsGateway, hasAcceptedCalls, acceptCalls } = makeTermsGateway();
  const props: Omit<HarnessProps, "handleRef"> = {
    documentId: "doc-1",
    language: "zh",
    session: makeSession("user-a"),
    client,
    termsGateway,
    ...overrides,
  };
  const utils = render(<Harness handleRef={handleRef} {...props} />);
  const rerender = (next: Partial<Omit<HarnessProps, "handleRef">>) => {
    Object.assign(props, next);
    utils.rerender(<Harness handleRef={handleRef} {...props} />);
  };
  return {
    handleRef,
    rerender,
    unmount: utils.unmount,
    polishCalls,
    quotaCalls,
    hasAcceptedCalls,
    acceptCalls,
    flow: () => {
      const flow = handleRef.current?.flow;
      if (!flow) throw new Error("flow not captured");
      return flow;
    },
    form: () => {
      const form = handleRef.current?.form;
      if (!form) throw new Error("form not captured");
      return form;
    },
  };
}

/** Open the dialog and complete the initial quota + terms (accepted) reads. */
async function openAccepted(h: ReturnType<typeof renderHarness>, scope: PolishScope = SCOPE) {
  act(() => {
    h.flow().open(scope);
  });
  expect(h.quotaCalls).toHaveLength(1);
  expect(h.hasAcceptedCalls).toHaveLength(1);
  await act(async () => {
    h.quotaCalls[0].resolve({ requestId: "q-1", quota: makeQuota(5) });
    h.hasAcceptedCalls[0].resolve(true);
  });
  expect(h.flow().terms.status).toBe("accepted");
  expect(h.flow().canConfirm).toBe(true);
}

/** Open with terms NOT accepted, tick the checkbox, and start confirm(). */
async function openRequiredAndConfirm(h: ReturnType<typeof renderHarness>) {
  act(() => {
    h.flow().open(SCOPE);
  });
  await act(async () => {
    h.quotaCalls[0].resolve({ requestId: "q-1", quota: makeQuota(5) });
    h.hasAcceptedCalls[0].resolve(false);
  });
  expect(h.flow().terms.status).toBe("required");
  act(() => {
    h.flow().terms.setChecked(true);
  });
  act(() => {
    h.flow().confirm();
  });
  expect(h.flow().terms.status).toBe("accepting");
  expect(h.acceptCalls).toHaveLength(1);
}

/** Drive the flow into the preview phase; returns the success response used. */
async function openAndReachPreview(h: ReturnType<typeof renderHarness>) {
  await openAccepted(h);
  act(() => {
    h.flow().confirm();
  });
  expect(h.polishCalls).toHaveLength(1);
  const request = h.polishCalls[0].request;
  await act(async () => {
    h.polishCalls[0].deferred.resolve(successResponse(request, 4));
  });
  expect(h.flow().state.phase).toBe("preview");
  return request;
}

// ---------------------------------------------------------------------------
// 1. terms-acceptance window: dismissal/change during accept() sends nothing
// ---------------------------------------------------------------------------

describe("terms-acceptance window", () => {
  it("sends the reviewed snapshot after acceptance (happy path)", async () => {
    const h = renderHarness();
    await openRequiredAndConfirm(h);
    const disclosed = h.flow().state.snapshot;
    expect(disclosed).not.toBeNull();
    await act(async () => {
      h.acceptCalls[0].resolve();
    });
    expect(h.polishCalls).toHaveLength(1);
    const sent = h.polishCalls[0].request;
    // Only the single-use clientRequestId differs from the reviewed snapshot.
    expect(sent.clientRequestId).not.toBe(disclosed!.apiRequest.clientRequestId);
    expect({ ...sent, clientRequestId: "fixed" }).toEqual({
      ...disclosed!.apiRequest,
      clientRequestId: "fixed",
    });
    expect(h.flow().state.phase).toBe("loading");
  });

  it("close during acceptance → no request", async () => {
    const h = renderHarness();
    await openRequiredAndConfirm(h);
    act(() => {
      h.flow().close();
    });
    await act(async () => {
      h.acceptCalls[0].resolve();
    });
    expect(h.polishCalls).toHaveLength(0);
    expect(h.flow().isOpen).toBe(false);
    expect(h.flow().state.phase).toBe("config");
  });

  it("unmount during acceptance → no request", async () => {
    const h = renderHarness();
    await openRequiredAndConfirm(h);
    h.unmount();
    await act(async () => {
      h.acceptCalls[0].resolve();
    });
    expect(h.polishCalls).toHaveLength(0);
  });

  it("document switch during acceptance → no request", async () => {
    const h = renderHarness();
    await openRequiredAndConfirm(h);
    act(() => {
      h.rerender({ documentId: "doc-2" });
    });
    await act(async () => {
      h.acceptCalls[0].resolve();
    });
    expect(h.polishCalls).toHaveLength(0);
    expect(h.flow().isOpen).toBe(false);
    expect(h.flow().state.phase).toBe("config");
  });

  it("level change during acceptance → disclosure rebuilt, no silent send", async () => {
    const h = renderHarness();
    await openRequiredAndConfirm(h);
    act(() => {
      h.flow().setLevel(2);
    });
    await act(async () => {
      h.acceptCalls[0].resolve();
    });
    expect(h.polishCalls).toHaveLength(0);
    expect(h.flow().state.phase).toBe("config");
    // The disclosure was rebuilt with the new level for explicit re-review.
    expect(h.flow().state.params.level).toBe(2);
    expect(h.flow().state.snapshot?.apiRequest.context.level).toBe(2);
  });

  it("form change during acceptance → disclosure rebuilt + hint, no silent send", async () => {
    const h = renderHarness();
    await openRequiredAndConfirm(h);
    const targetPath = h.flow().state.snapshot!.targets[0].path;
    act(() => {
      h.form().setValue(targetPath as never, "云端同步进来的新内容，长度足够。" as never);
    });
    await act(async () => {
      h.acceptCalls[0].resolve();
    });
    expect(h.polishCalls).toHaveLength(0);
    expect(h.flow().state.phase).toBe("config");
    expect(h.flow().configChangedHint).toBe(true);
  });

  it("failed acceptance write → terms error, no request", async () => {
    const h = renderHarness();
    await openRequiredAndConfirm(h);
    await act(async () => {
      h.acceptCalls[0].reject(new Error("network"));
    });
    expect(h.polishCalls).toHaveLength(0);
    expect(h.flow().terms.status).toBe("error");
    expect(h.flow().state.phase).toBe("config");
  });
});

// ---------------------------------------------------------------------------
// 2. in-flight ownership: late settle of a canceled request disturbs nothing
// ---------------------------------------------------------------------------

describe("in-flight request ownership", () => {
  async function cancelAStartB(h: ReturnType<typeof renderHarness>) {
    await openAccepted(h);
    act(() => {
      h.flow().confirm();
    });
    expect(h.polishCalls).toHaveLength(1);
    expect(h.flow().state.phase).toBe("loading");
    act(() => {
      h.flow().cancel();
    });
    expect(h.flow().state.phase).toBe("config");
    // B starts before A settles (hook-level; the UI blocks its button until
    // the quota re-read lands — covered in the cancel-quota tests).
    act(() => {
      h.flow().confirm();
    });
    expect(h.polishCalls).toHaveLength(2);
    expect(h.flow().state.phase).toBe("loading");
  }

  it("cancel A, start B, A resolves successfully → B untouched", async () => {
    const h = renderHarness();
    await cancelAStartB(h);
    const bRequestId = h.flow().state.clientRequestId;
    await act(async () => {
      h.polishCalls[0].deferred.resolve(successResponse(h.polishCalls[0].request, 3, "srv-A"));
    });
    // A's late success must not move the reducer, quota or terms state; its
    // only side effect is the canceled operation's settle-point quota re-read.
    expect(h.quotaCalls).toHaveLength(2);
    expect(h.flow().state.phase).toBe("loading");
    expect(h.flow().state.clientRequestId).toBe(bRequestId);
    expect(h.flow().quota).toBeNull();
    expect(h.flow().terms.serverRejected).toBe(false);
    await act(async () => {
      h.quotaCalls[1].resolve({ requestId: "q-2", quota: makeQuota(5) });
    });
    // B is still cancellable and completes normally.
    await act(async () => {
      h.polishCalls[1].deferred.resolve(successResponse(h.polishCalls[1].request, 4, "srv-B"));
    });
    expect(h.flow().state.phase).toBe("preview");
    expect(h.flow().quota?.remaining).toBe(4);
  });

  it("cancel A, start B, A returns 403 AI_TERMS_REQUIRED → B untouched", async () => {
    const h = renderHarness();
    await cancelAStartB(h);
    const bRequestId = h.flow().state.clientRequestId;
    await act(async () => {
      h.polishCalls[0].deferred.reject(new PolishApiError({ code: "AI_TERMS_REQUIRED", status: 403 }));
    });
    // A's 403 must NOT re-show the checkbox or abort B's request.
    expect(h.quotaCalls).toHaveLength(2);
    expect(h.flow().terms.serverRejected).toBe(false);
    expect(h.flow().terms.status).toBe("accepted");
    expect(h.flow().state.phase).toBe("loading");
    expect(h.flow().state.clientRequestId).toBe(bRequestId);
    await act(async () => {
      h.quotaCalls[1].resolve({ requestId: "q-2", quota: makeQuota(5) });
      h.polishCalls[1].deferred.resolve(successResponse(h.polishCalls[1].request, 4, "srv-B"));
    });
    expect(h.flow().state.phase).toBe("preview");
  });

  it("cancel A, start B, A fails with a network error → B untouched", async () => {
    const h = renderHarness();
    await cancelAStartB(h);
    const bRequestId = h.flow().state.clientRequestId;
    await act(async () => {
      h.polishCalls[0].deferred.reject(
        new PolishApiError({ code: POLISH_TRANSPORT_ERROR_CODES.networkError }),
      );
    });
    expect(h.quotaCalls).toHaveLength(2);
    expect(h.flow().state.phase).toBe("loading");
    expect(h.flow().state.clientRequestId).toBe(bRequestId);
    expect(h.flow().state.error).toBeNull();
    await act(async () => {
      h.quotaCalls[1].resolve({ requestId: "q-2", quota: makeQuota(5) });
      h.polishCalls[1].deferred.resolve(successResponse(h.polishCalls[1].request, 4, "srv-B"));
    });
    expect(h.flow().state.phase).toBe("preview");
  });

  it("close during loading aborts; the late response changes nothing", async () => {
    const h = renderHarness();
    await openAccepted(h);
    act(() => {
      h.flow().confirm();
    });
    act(() => {
      h.flow().close();
    });
    await act(async () => {
      h.polishCalls[0].deferred.resolve(successResponse(h.polishCalls[0].request, 4, "srv-A"));
    });
    expect(h.flow().isOpen).toBe(false);
    expect(h.flow().state.phase).toBe("config");
    expect(h.flow().state.items).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 3. snapshot identity barriers (document / language / references)
// ---------------------------------------------------------------------------

describe("write-back identity barriers", () => {
  it("reference drift during preview blocks Accept (nothing written)", async () => {
    const h = renderHarness();
    await openAndReachPreview(h);
    const snapshot = h.flow().state.snapshot!;
    expect(snapshot.referencePaths.length).toBeGreaterThan(0);
    const item = h.flow().state.items[0];
    const before = h.form().getValues(item.path as never);
    act(() => {
      h.form().setValue(snapshot.referencePaths[0] as never, "漂移后的引用文本" as never);
    });
    act(() => {
      h.flow().acceptItem(item.id);
    });
    expect(h.form().getValues(item.path as never)).toBe(before);
    expect(h.flow().state.items[0].state).toBe("pending");
    expect(h.flow().staleItemIds.has(item.id)).toBe(true);
    expect(h.flow().referencesStale).toBe(true);
  });

  it("reference drift blocks Accept All up front (no partial batch)", async () => {
    const h = renderHarness();
    await openAndReachPreview(h);
    const snapshot = h.flow().state.snapshot!;
    const paths = h.flow().state.items.map((item) => item.path);
    const before = paths.map((path) => h.form().getValues(path as never));
    act(() => {
      h.form().setValue(snapshot.referencePaths[0] as never, "漂移后的引用文本" as never);
    });
    act(() => {
      h.flow().acceptAll();
    });
    expect(paths.map((path) => h.form().getValues(path as never))).toEqual(before);
    expect(h.flow().state.items.every((item) => item.state === "pending")).toBe(true);
    expect(h.flow().referencesStale).toBe(true);
  });

  it("language change with identical text blocks confirm and write-back", async () => {
    const h = renderHarness();
    await openAccepted(h);
    // Same document, every string identical, only typstLang flipped (cloud reset).
    act(() => {
      h.rerender({ language: "en" });
    });
    act(() => {
      h.flow().confirm();
    });
    // No silent send in the new language: disclosure rebuilt for re-review.
    expect(h.polishCalls).toHaveLength(0);
    expect(h.flow().configChangedHint).toBe(true);
    expect(h.flow().state.snapshot?.apiRequest.language).toBe("en");
  });

  it("language change during preview blocks Accept", async () => {
    const h = renderHarness();
    await openAndReachPreview(h);
    const item = h.flow().state.items[0];
    const before = h.form().getValues(item.path as never);
    act(() => {
      h.rerender({ language: "en" });
    });
    act(() => {
      h.flow().acceptItem(item.id);
    });
    expect(h.form().getValues(item.path as never)).toBe(before);
    expect(h.flow().state.items[0].state).toBe("pending");
    expect(h.flow().staleItemIds.has(item.id)).toBe(true);
  });

  it("document switch during loading aborts and resets", async () => {
    const h = renderHarness();
    await openAccepted(h);
    act(() => {
      h.flow().confirm();
    });
    expect(h.flow().state.phase).toBe("loading");
    act(() => {
      h.rerender({ documentId: "doc-2" });
    });
    expect(h.flow().state.phase).toBe("config");
    expect(h.flow().isOpen).toBe(false);
    await act(async () => {
      h.polishCalls[0].deferred.resolve(successResponse(h.polishCalls[0].request, 4, "srv-A"));
    });
    expect(h.flow().state.phase).toBe("config");
    expect(h.flow().state.items).toHaveLength(0);
  });

  it("document switch during preview aborts and resets", async () => {
    const h = renderHarness();
    await openAndReachPreview(h);
    act(() => {
      h.rerender({ documentId: "doc-2" });
    });
    expect(h.flow().state.phase).toBe("config");
    expect(h.flow().isOpen).toBe(false);
  });

  it("stale references do NOT prevent undoing an accepted item", async () => {
    const h = renderHarness();
    await openAndReachPreview(h);
    const snapshot = h.flow().state.snapshot!;
    const item = h.flow().state.items[0];
    const original = h.form().getValues(item.path as never);
    act(() => {
      h.flow().acceptItem(item.id);
    });
    expect(h.form().getValues(item.path as never)).toBe(item.polished);
    // References drift AFTER the accept: undo must still restore the original.
    act(() => {
      h.form().setValue(snapshot.referencePaths[0] as never, "漂移后的引用文本" as never);
    });
    act(() => {
      h.flow().undoAcceptItem(item.id);
    });
    expect(h.form().getValues(item.path as never)).toBe(original);
    expect(h.flow().state.items[0].state).toBe("pending");
  });

  it("target-path drift still blocks Accept (existing expectedCurrent guard)", async () => {
    const h = renderHarness();
    await openAndReachPreview(h);
    const item = h.flow().state.items[0];
    const before = h.form().getValues(item.path as never);
    act(() => {
      h.form().setValue(item.path as never, "目标字段被外部改动过，内容足够长。" as never);
    });
    act(() => {
      h.flow().acceptItem(item.id);
    });
    expect(h.flow().state.items[0].state).toBe("pending");
    expect(h.flow().staleItemIds.has(item.id)).toBe(true);
    expect(h.form().getValues(item.path as never)).not.toBe(before);
  });
});

// ---------------------------------------------------------------------------
// 4. terms/quota state is keyed to the account
// ---------------------------------------------------------------------------

describe("account keying", () => {
  it("account change resets terms/quota and closes the dialog; B must re-query", async () => {
    const h = renderHarness();
    await openAccepted(h);
    expect(h.flow().terms.status).toBe("accepted");
    act(() => {
      h.rerender({ session: makeSession("user-b") });
    });
    expect(h.flow().terms.status).toBe("unknown");
    expect(h.flow().terms.checked).toBe(false);
    expect(h.flow().isOpen).toBe(false);
    expect(h.flow().quota).toBeNull();
    // B opens the dialog: a fresh query runs and confirm waits for it.
    act(() => {
      h.flow().open(SCOPE);
    });
    expect(h.hasAcceptedCalls).toHaveLength(2);
    expect(h.flow().terms.status).toBe("checking");
    expect(h.flow().canConfirm).toBe(false);
    await act(async () => {
      h.quotaCalls[1].resolve({ requestId: "q-2", quota: makeQuota(7) });
      h.hasAcceptedCalls[1].resolve(false);
    });
    expect(h.flow().terms.status).toBe("required");
    // B has not consented yet.
    expect(h.flow().canConfirm).toBe(false);
    act(() => {
      h.flow().terms.setChecked(true);
    });
    expect(h.flow().canConfirm).toBe(true);
  });

  it("a late resolve of A's terms query never lands in B's gate", async () => {
    const h = renderHarness();
    act(() => {
      h.flow().open(SCOPE);
    });
    expect(h.hasAcceptedCalls).toHaveLength(1);
    // Switch accounts BEFORE A's query resolves.
    act(() => {
      h.rerender({ session: makeSession("user-b") });
    });
    act(() => {
      h.flow().open(SCOPE);
    });
    expect(h.hasAcceptedCalls).toHaveLength(2);
    expect(h.flow().terms.status).toBe("checking");
    // A's query resolves late: dropped, B still checking.
    await act(async () => {
      h.hasAcceptedCalls[0].resolve(true);
    });
    expect(h.flow().terms.status).toBe("checking");
    await act(async () => {
      h.hasAcceptedCalls[1].resolve(true);
      h.quotaCalls[1].resolve({ requestId: "q-2", quota: makeQuota(7) });
    });
    expect(h.flow().terms.status).toBe("accepted");
  });

  it("account change during terms acceptance → no request, gate reset", async () => {
    const h = renderHarness();
    await openRequiredAndConfirm(h);
    act(() => {
      h.rerender({ session: makeSession("user-b") });
    });
    await act(async () => {
      h.acceptCalls[0].resolve();
    });
    expect(h.polishCalls).toHaveLength(0);
    expect(h.flow().terms.status).toBe("unknown");
    expect(h.flow().isOpen).toBe(false);
  });

  it("a late resolve of A's quota query never lands in B's quota display", async () => {
    const h = renderHarness();
    act(() => {
      h.flow().open(SCOPE);
    });
    expect(h.quotaCalls).toHaveLength(1);
    act(() => {
      h.rerender({ session: makeSession("user-b") });
    });
    act(() => {
      h.flow().open(SCOPE);
    });
    expect(h.quotaCalls).toHaveLength(2);
    await act(async () => {
      h.quotaCalls[0].resolve({ requestId: "q-1", quota: makeQuota(1) });
    });
    expect(h.flow().quota).toBeNull();
    await act(async () => {
      h.quotaCalls[1].resolve({ requestId: "q-2", quota: makeQuota(9) });
      h.hasAcceptedCalls[1].resolve(true);
    });
    expect(h.flow().quota?.remaining).toBe(9);
  });
});

// ---------------------------------------------------------------------------
// 5. cancel discards the quota display until the settle-point re-read lands
// ---------------------------------------------------------------------------

describe("cancel quota refresh", () => {
  it("cancel marks quota stale, blocks confirm, refreshes from the settle point", async () => {
    const h = renderHarness();
    await openAccepted(h);
    act(() => {
      h.flow().confirm();
    });
    expect(h.flow().state.phase).toBe("loading");
    act(() => {
      h.flow().cancel();
    });
    expect(h.flow().state.phase).toBe("config");
    // The pre-request count is discarded; confirm waits for the re-read.
    expect(h.flow().quota).toBeNull();
    expect(h.flow().quotaStatus).toBe("loading");
    expect(h.flow().canConfirm).toBe(false);
    // No re-read yet: it fires from the request's settlement point, not abort().
    expect(h.quotaCalls).toHaveLength(1);
    await act(async () => {
      h.polishCalls[0].deferred.reject(abortError());
    });
    expect(h.quotaCalls).toHaveLength(2);
    await act(async () => {
      h.quotaCalls[1].resolve({ requestId: "q-2", quota: makeQuota(4) });
    });
    expect(h.flow().quotaStatus).toBe("ready");
    expect(h.flow().quota?.remaining).toBe(4);
    expect(h.flow().canConfirm).toBe(true);
  });

  it("a canceled request resolving successfully still triggers the re-read", async () => {
    const h = renderHarness();
    await openAccepted(h);
    act(() => {
      h.flow().confirm();
    });
    act(() => {
      h.flow().cancel();
    });
    // The response raced the abort: late success. Quota must still be re-read
    // (and the late response itself must not become the displayed quota).
    await act(async () => {
      h.polishCalls[0].deferred.resolve(successResponse(h.polishCalls[0].request, 1, "srv-A"));
    });
    expect(h.quotaCalls).toHaveLength(2);
    expect(h.flow().quota).toBeNull();
    expect(h.flow().quotaStatus).toBe("loading");
    await act(async () => {
      h.quotaCalls[1].resolve({ requestId: "q-2", quota: makeQuota(3) });
    });
    expect(h.flow().quota?.remaining).toBe(3);
    expect(h.flow().canConfirm).toBe(true);
  });
});
