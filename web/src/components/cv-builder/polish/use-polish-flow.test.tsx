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
 *
 * Round 2 additions:
 * - commit-synchronous invalidation: a parent layout effect resolving the
 *   pending acceptance/response right as an account/document switch commits
 *   must find the hook already invalidated (no send, no apply);
 * - acceptAll validates EVERY target (including already-accepted items)
 *   before the first write;
 * - a superseded terms acceptance (failure OR success) never moves a newer
 *   dialog; an invalidated "accepting" gate is unlocked, never stuck;
 * - quota/terms continuations are generation-scoped and account-owned;
 * - X/close during loading shares cancel's settlement semantics: confirm
 *   stays blocked across a reopen until the settle-point re-read lands;
 * - write-back barriers are tiered by the transition's actual effect:
 *   reference/language drift never blocks reject / undo-reject / reject-all
 *   restores.
 */

import type { Session } from "@supabase/supabase-js";
import { act, cleanup, render } from "@testing-library/react";
import {
  createRef,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
  type RefObject,
} from "react";
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
  const polishCalls: Array<{
    request: PolishRequest;
    deferred: Deferred<PolishSuccessResponse>;
    signal: AbortSignal | undefined;
  }> = [];
  const quotaCalls: Array<Deferred<PolishQuotaResponse>> = [];
  const client: PolishApiClient = {
    polish: vi.fn((request: PolishRequest, options?: { signal?: AbortSignal }) => {
      const call = deferred<PolishSuccessResponse>();
      polishCalls.push({ request, deferred: call, signal: options?.signal });
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

// ---------------------------------------------------------------------------
// 6. round 2: commit-synchronous invalidation (parent layout-effect race)
// ---------------------------------------------------------------------------

interface RaceParentHandle {
  flow: PolishFlow | null;
  form: UseFormReturn<CvData> | null;
  switchSession: (userId: string) => void;
  switchDocument: (documentId: string) => void;
}

/**
 * Owns session/document state itself and fires onCommit from a layout effect
 * exactly when a commit publishes a NEW account or document. Combined with
 * triggering the switch outside act(), this reproduces production ordering:
 * commit → layout effects (onCommit resolves the pending promise) → promise
 * continuations (microtasks) → passive effects. The hook must already have
 * published the new identity and invalidated the old operation by the time
 * the continuation runs — a passive-effect hook fails these tests.
 */
function RaceParent({
  handleRef,
  onCommit,
  client,
  termsGateway,
}: {
  handleRef: RefObject<RaceParentHandle | null>;
  onCommit: () => void;
  client: PolishApiClient;
  termsGateway: PolishTermsGateway;
}) {
  const [session, setSession] = useState<Session>(() => makeSession("user-a"));
  const [documentId, setDocumentId] = useState("doc-1");
  const form = useForm<CvData>({ defaultValues: makeCvData() });
  const flow = usePolishFlow({
    form,
    documentId,
    language: "zh",
    session,
    supabase: null,
    client,
    termsGateway,
  });
  const committedRef = useRef<{ userId: string; documentId: string } | null>(null);
  useLayoutEffect(() => {
    const committed = { userId: session.user.id, documentId };
    const previous = committedRef.current;
    committedRef.current = committed;
    if (
      previous !== null &&
      (previous.userId !== committed.userId || previous.documentId !== committed.documentId)
    ) {
      onCommit();
      // Keep this commit task above the Scheduler's 5ms frame budget so the
      // work loop yields to the host before flushing the child's passive
      // effects — the promise continuation (a microtask) then runs in the
      // exact layout→passive window the round-2 fix closes. Without the
      // burn, React flushes passive effects inside the same work-loop turn
      // and the window never materializes in tests.
      const deadline = Date.now() + 25;
      while (Date.now() < deadline) {
        // busy-wait: force the Scheduler to yield before passive effects
      }
    }
  });
  useImperativeHandle(handleRef, () => ({
    flow,
    form,
    switchSession: (userId: string) => setSession(makeSession(userId)),
    switchDocument: (next: string) => setDocumentId(next),
  }));
  return null;
}

function renderRaceParent() {
  const handleRef = createRef<RaceParentHandle>();
  const { client, polishCalls, quotaCalls } = makeClient();
  const { termsGateway, hasAcceptedCalls, acceptCalls } = makeTermsGateway();
  const onCommitRef: { current: (() => void) | null } = { current: null };
  render(
    <RaceParent
      handleRef={handleRef}
      onCommit={() => onCommitRef.current?.()}
      client={client}
      termsGateway={termsGateway}
    />,
  );
  return {
    handleRef,
    onCommitRef,
    polishCalls,
    quotaCalls,
    hasAcceptedCalls,
    acceptCalls,
    flow: () => {
      const flow = handleRef.current?.flow;
      if (!flow) throw new Error("flow not captured");
      return flow;
    },
  };
}

/**
 * Flush the work an outside-act update schedules the way the browser would:
 * the commit's layout effects run (onCommit resolves the promise), the
 * busy-wait in RaceParent's layout effect pushes the commit task over the
 * Scheduler's frame budget so the work loop yields, and the promise
 * continuation (a microtask) then runs BEFORE the child's passive effects.
 *
 * The leading microtask checkpoint OUTSIDE act is load-bearing: without it
 * the commit lands inside act's synchronous flushActQueue, which always
 * flushes passive effects before any microtask can run — hiding the window
 * these tests exist to exercise (verified against the pre-fix hook).
 */
async function flushRealScheduling() {
  await Promise.resolve();
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

describe("round 2: commit-synchronous invalidation", () => {
  it("account switch committed while acceptance pending: the in-layout resolve sends no request", async () => {
    const h = renderRaceParent();
    act(() => {
      h.flow().open(SCOPE);
    });
    await act(async () => {
      h.quotaCalls[0].resolve({ requestId: "q-1", quota: makeQuota(5) });
      h.hasAcceptedCalls[0].resolve(false);
    });
    act(() => {
      h.flow().terms.setChecked(true);
    });
    act(() => {
      h.flow().confirm();
    });
    expect(h.acceptCalls).toHaveLength(1);
    expect(h.flow().terms.status).toBe("accepting");
    // Resolve A's acceptance the instant the account switch commits — the
    // continuation races the hook's identity publication.
    h.onCommitRef.current = () => h.acceptCalls[0].resolve();
    const actWarning = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      h.handleRef.current!.switchSession("user-b");
      await flushRealScheduling();
    } finally {
      actWarning.mockRestore();
    }
    expect(h.polishCalls).toHaveLength(0);
    expect(h.flow().terms.status).toBe("unknown");
    expect(h.flow().isOpen).toBe(false);
  });

  it("document switch committed while request in flight: the in-layout response applies nothing", async () => {
    const h = renderRaceParent();
    act(() => {
      h.flow().open(SCOPE);
    });
    await act(async () => {
      h.quotaCalls[0].resolve({ requestId: "q-1", quota: makeQuota(5) });
      h.hasAcceptedCalls[0].resolve(true);
    });
    act(() => {
      h.flow().confirm();
    });
    expect(h.polishCalls).toHaveLength(1);
    expect(h.flow().state.phase).toBe("loading");
    h.onCommitRef.current = () =>
      h.polishCalls[0].deferred.resolve(successResponse(h.polishCalls[0].request, 4, "srv-A"));
    const actWarning = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      h.handleRef.current!.switchDocument("doc-2");
      await flushRealScheduling();
    } finally {
      actWarning.mockRestore();
    }
    expect(h.flow().state.phase).toBe("config");
    expect(h.flow().state.items).toHaveLength(0);
    expect(h.flow().isOpen).toBe(false);
    // The late response must not become the displayed quota; the invalidated
    // in-flight request owes a settle-point re-read instead.
    expect(h.flow().quota?.remaining ?? null).not.toBe(4);
    expect(h.quotaCalls).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// 7. round 2: acceptAll validates every target before the first write
// ---------------------------------------------------------------------------

describe("round 2: acceptAll full-batch preflight", () => {
  it("target drift on a later item blocks the whole batch (first target untouched)", async () => {
    const h = renderHarness();
    await openAndReachPreview(h);
    const items = h.flow().state.items;
    expect(items.length).toBeGreaterThanOrEqual(2);
    const beforeFirst = h.form().getValues(items[0].path as never);
    act(() => {
      h.form().setValue(items[1].path as never, "第二项被外部改动过，内容足够长。" as never);
    });
    act(() => {
      h.flow().acceptAll();
    });
    expect(h.form().getValues(items[0].path as never)).toBe(beforeFirst);
    expect(h.flow().state.items.every((item) => item.state === "pending")).toBe(true);
    expect(h.flow().staleItemIds.has(items[1].id)).toBe(true);
  });

  it("an externally reverted accepted item blocks the whole batch", async () => {
    const h = renderHarness();
    await openAndReachPreview(h);
    const items = h.flow().state.items;
    act(() => {
      h.flow().acceptItem(items[0].id);
    });
    expect(h.form().getValues(items[0].path as never)).toBe(items[0].polished);
    // External edit clobbers the accepted write-back: reducer and form diverged.
    act(() => {
      h.form().setValue(items[0].path as never, "外部还原成了别的内容，长度足够。" as never);
    });
    const beforeSecond = h.form().getValues(items[1].path as never);
    act(() => {
      h.flow().acceptAll();
    });
    expect(h.form().getValues(items[1].path as never)).toBe(beforeSecond);
    expect(h.flow().state.items[1].state).toBe("pending");
    expect(h.flow().staleItemIds.has(items[0].id)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 8. round 2: a superseded terms acceptance never moves a newer dialog
// ---------------------------------------------------------------------------

describe("round 2: superseded terms acceptance", () => {
  async function closeAndReopenWhileAcceptPending(h: ReturnType<typeof renderHarness>) {
    await openRequiredAndConfirm(h);
    act(() => {
      h.flow().close();
    });
    // Reopen on the same account before the old acceptance settles: the gate
    // must be unlocked (never stuck in "accepting") and a fresh query runs.
    act(() => {
      h.flow().open(SCOPE);
    });
    expect(h.hasAcceptedCalls).toHaveLength(2);
    expect(h.flow().terms.status).toBe("checking");
    await act(async () => {
      h.quotaCalls[1].resolve({ requestId: "q-2", quota: makeQuota(5) });
      h.hasAcceptedCalls[1].resolve(false);
    });
    expect(h.flow().terms.status).toBe("required");
  }

  it("old accept failure after close+reopen does not error the new dialog", async () => {
    const h = renderHarness();
    await closeAndReopenWhileAcceptPending(h);
    await act(async () => {
      h.acceptCalls[0].reject(new Error("network"));
    });
    expect(h.flow().terms.status).toBe("required");
    expect(h.polishCalls).toHaveLength(0);
  });

  it("old accept success after close+reopen does not overwrite the new query", async () => {
    const h = renderHarness();
    await closeAndReopenWhileAcceptPending(h);
    await act(async () => {
      h.acceptCalls[0].resolve();
    });
    // The new query said "required"; the superseded acceptance must not flip it.
    expect(h.flow().terms.status).toBe("required");
    expect(h.polishCalls).toHaveLength(0);
  });

  it("param change during acceptance unlocks the gate and re-queries", async () => {
    const h = renderHarness();
    await openRequiredAndConfirm(h);
    act(() => {
      h.flow().setLevel(2);
    });
    expect(h.hasAcceptedCalls).toHaveLength(2);
    await act(async () => {
      h.hasAcceptedCalls[1].resolve(false);
      h.acceptCalls[0].resolve();
    });
    // The new query owns the gate: required, not stuck accepting, not
    // flipped by the superseded success.
    expect(h.flow().terms.status).toBe("required");
    expect(h.polishCalls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 9. round 2: quota/terms continuations are generation-scoped + account-owned
// ---------------------------------------------------------------------------

describe("round 2: quota/terms generation and account ownership", () => {
  it("A cancels, account switches to B, A settles: B's quota state untouched", async () => {
    const h = renderHarness();
    await openAccepted(h);
    act(() => {
      h.flow().confirm();
    });
    act(() => {
      h.flow().cancel();
    });
    act(() => {
      h.rerender({ session: makeSession("user-b") });
    });
    act(() => {
      h.flow().open(SCOPE);
    });
    expect(h.quotaCalls).toHaveLength(2);
    expect(h.hasAcceptedCalls).toHaveLength(2);
    // A's canceled request settles: no settle-point re-read under B.
    await act(async () => {
      h.polishCalls[0].deferred.reject(abortError());
    });
    expect(h.quotaCalls).toHaveLength(2);
    // B's own read completes normally — never stuck in the loading state an
    // old-account settle could otherwise leave behind.
    await act(async () => {
      h.quotaCalls[1].resolve({ requestId: "q-2", quota: makeQuota(9) });
      h.hasAcceptedCalls[1].resolve(true);
    });
    expect(h.flow().quotaStatus).toBe("ready");
    expect(h.flow().quota?.remaining).toBe(9);
  });

  it("two same-account quota reads resolving out of order: the newer wins", async () => {
    const h = renderHarness();
    act(() => {
      h.flow().open(SCOPE);
    });
    expect(h.quotaCalls).toHaveLength(1);
    act(() => {
      h.flow().quotaRetry();
    });
    expect(h.quotaCalls).toHaveLength(2);
    await act(async () => {
      h.quotaCalls[1].resolve({ requestId: "q-2", quota: makeQuota(9) });
    });
    expect(h.flow().quota?.remaining).toBe(9);
    // The older read resolves late: dropped, never overwrites the newer one.
    await act(async () => {
      h.quotaCalls[0].resolve({ requestId: "q-1", quota: makeQuota(1) });
    });
    expect(h.flow().quota?.remaining).toBe(9);
  });

  it("two same-account terms queries resolving out of order: the newer result stands", async () => {
    const h = renderHarness();
    act(() => {
      h.flow().open(SCOPE);
    });
    expect(h.hasAcceptedCalls).toHaveLength(1);
    act(() => {
      h.flow().refreshTerms();
    });
    expect(h.hasAcceptedCalls).toHaveLength(2);
    await act(async () => {
      h.hasAcceptedCalls[1].resolve(true);
    });
    expect(h.flow().terms.status).toBe("accepted");
    await act(async () => {
      h.hasAcceptedCalls[0].resolve(false);
    });
    expect(h.flow().terms.status).toBe("accepted");
  });
});

// ---------------------------------------------------------------------------
// 10. round 2: X/close during loading shares cancel's settlement semantics
// ---------------------------------------------------------------------------

describe("round 2: unified loading-close settlement", () => {
  it("close during loading: a pre-settlement reopen read cannot unblock confirm", async () => {
    const h = renderHarness();
    await openAccepted(h);
    act(() => {
      h.flow().confirm();
    });
    expect(h.flow().state.phase).toBe("loading");
    act(() => {
      h.flow().close();
    });
    // Same as cancel(): quota discarded, settlement owed.
    expect(h.flow().quota).toBeNull();
    expect(h.flow().quotaStatus).toBe("loading");
    // Reopen before the canceled request settles: the ordinary open read
    // lands first, but must NOT unblock confirm.
    act(() => {
      h.flow().open(SCOPE);
    });
    expect(h.quotaCalls).toHaveLength(2);
    await act(async () => {
      h.quotaCalls[1].resolve({ requestId: "q-2", quota: makeQuota(5) });
      h.hasAcceptedCalls[1].resolve(true);
    });
    expect(h.flow().quotaStatus).toBe("ready");
    expect(h.flow().quota?.remaining).toBe(5);
    expect(h.flow().canConfirm).toBe(false);
    // The canceled request settles → settle-point re-read → confirm unblocks.
    await act(async () => {
      h.polishCalls[0].deferred.reject(abortError());
    });
    expect(h.quotaCalls).toHaveLength(3);
    await act(async () => {
      h.quotaCalls[2].resolve({ requestId: "q-3", quota: makeQuota(4) });
    });
    expect(h.flow().quota?.remaining).toBe(4);
    expect(h.flow().canConfirm).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 11. round 2: write-back barriers tiered by the transition's actual effect
// ---------------------------------------------------------------------------

describe("round 2: effect-tiered write-back barriers", () => {
  it("reference drift does not block rejecting a pending item", async () => {
    const h = renderHarness();
    await openAndReachPreview(h);
    const snapshot = h.flow().state.snapshot!;
    const item = h.flow().state.items[0];
    act(() => {
      h.form().setValue(snapshot.referencePaths[0] as never, "漂移后的引用文本" as never);
    });
    act(() => {
      h.flow().rejectItem(item.id);
    });
    expect(h.flow().state.items[0].state).toBe("rejected");
    expect(h.flow().staleItemIds.has(item.id)).toBe(false);
  });

  it("language drift does not block rejecting a pending item", async () => {
    const h = renderHarness();
    await openAndReachPreview(h);
    const item = h.flow().state.items[0];
    act(() => {
      h.rerender({ language: "en" });
    });
    act(() => {
      h.flow().rejectItem(item.id);
    });
    expect(h.flow().state.items[0].state).toBe("rejected");
  });

  it("reference drift does not block undoing a rejection", async () => {
    const h = renderHarness();
    await openAndReachPreview(h);
    const snapshot = h.flow().state.snapshot!;
    const item = h.flow().state.items[0];
    act(() => {
      h.flow().rejectItem(item.id);
    });
    act(() => {
      h.form().setValue(snapshot.referencePaths[0] as never, "漂移后的引用文本" as never);
    });
    act(() => {
      h.flow().undoRejectItem(item.id);
    });
    expect(h.flow().state.items[0].state).toBe("pending");
  });

  it("Reject All restores accepted values despite reference drift", async () => {
    const h = renderHarness();
    await openAndReachPreview(h);
    const snapshot = h.flow().state.snapshot!;
    const items = h.flow().state.items;
    const original = h.form().getValues(items[0].path as never);
    act(() => {
      h.flow().acceptItem(items[0].id);
    });
    expect(h.form().getValues(items[0].path as never)).toBe(items[0].polished);
    act(() => {
      h.form().setValue(snapshot.referencePaths[0] as never, "漂移后的引用文本" as never);
    });
    act(() => {
      h.flow().rejectAll();
    });
    expect(h.form().getValues(items[0].path as never)).toBe(original);
    expect(h.flow().state.items.every((item) => item.state === "rejected")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 12. round 4: unmount invalidation is commit-synchronous too
// ---------------------------------------------------------------------------

interface UnmountRaceChildHandle {
  flow: PolishFlow | null;
  form: UseFormReturn<CvData> | null;
}

interface UnmountRaceHandle {
  flow: PolishFlow | null;
  form: UseFormReturn<CvData> | null;
  unmountChild: () => void;
}

function UnmountRaceChild({
  childRef,
  client,
  termsGateway,
}: {
  childRef: RefObject<UnmountRaceChildHandle | null>;
  client: PolishApiClient;
  termsGateway: PolishTermsGateway;
}) {
  const [session] = useState(() => makeSession("user-a"));
  const form = useForm<CvData>({ defaultValues: makeCvData() });
  const flow = usePolishFlow({
    form,
    documentId: "doc-1",
    language: "zh",
    session,
    supabase: null,
    client,
    termsGateway,
  });
  useImperativeHandle(childRef, () => ({ flow, form }));
  return null;
}

/**
 * Parallel to RaceParent, but the raced boundary is REMOVAL: the parent
 * conditionally renders the hook host and fires onCommit from a layout
 * effect in the very commit that unmounts the child. Child layout-effect
 * cleanups run before the parent's layout effects (children-first), so a
 * commit-synchronous child is already dead here; a passive-cleanup child
 * (the pre-fix hook) is still mounted/owned until the passive flush — the
 * continuation resolved below lands exactly in that window.
 */
function UnmountRaceParent({
  handleRef,
  onCommit,
  client,
  termsGateway,
}: {
  handleRef: RefObject<UnmountRaceHandle | null>;
  onCommit: () => void;
  client: PolishApiClient;
  termsGateway: PolishTermsGateway;
}) {
  const [childMounted, setChildMounted] = useState(true);
  const childRef = useRef<UnmountRaceChildHandle | null>(null);
  const wasMountedRef = useRef(true);
  useLayoutEffect(() => {
    const wasMounted = wasMountedRef.current;
    wasMountedRef.current = childMounted;
    if (wasMounted && !childMounted) {
      onCommit();
      const deadline = Date.now() + 25;
      while (Date.now() < deadline) {
        // busy-wait: force the Scheduler to yield before passive effects
      }
    }
  });
  useImperativeHandle(handleRef, () => ({
    // Live accessors: the parent does not re-render on child state changes,
    // so a value copied here at parent commit time would go stale.
    get flow() {
      return childRef.current?.flow ?? null;
    },
    get form() {
      return childRef.current?.form ?? null;
    },
    unmountChild: () => setChildMounted(false),
  }));
  return childMounted ? (
    <UnmountRaceChild childRef={childRef} client={client} termsGateway={termsGateway} />
  ) : null;
}

function renderUnmountRace() {
  const handleRef = createRef<UnmountRaceHandle>();
  const { client, polishCalls, quotaCalls } = makeClient();
  const { termsGateway, hasAcceptedCalls, acceptCalls } = makeTermsGateway();
  const onCommitRef: { current: (() => void) | null } = { current: null };
  render(
    <UnmountRaceParent
      handleRef={handleRef}
      onCommit={() => onCommitRef.current?.()}
      client={client}
      termsGateway={termsGateway}
    />,
  );
  return {
    handleRef,
    onCommitRef,
    polishCalls,
    quotaCalls,
    hasAcceptedCalls,
    acceptCalls,
    flow: () => {
      const flow = handleRef.current?.flow;
      if (!flow) throw new Error("flow not captured");
      return flow;
    },
  };
}

describe("round 4: commit-synchronous unmount invalidation", () => {
  it("unmount while acceptance pending: resolving inside the unmount commit sends nothing", async () => {
    const h = renderUnmountRace();
    act(() => {
      h.flow().open(SCOPE);
    });
    await act(async () => {
      h.quotaCalls[0].resolve({ requestId: "q-1", quota: makeQuota(5) });
      h.hasAcceptedCalls[0].resolve(false);
    });
    act(() => {
      h.flow().terms.setChecked(true);
    });
    act(() => {
      h.flow().confirm();
    });
    expect(h.acceptCalls).toHaveLength(1);
    expect(h.flow().terms.status).toBe("accepting");
    // Resolve the acceptance INSIDE the unmount commit: the continuation
    // races the child's (passive, pre-fix) cleanup.
    h.onCommitRef.current = () => h.acceptCalls[0].resolve();
    const actWarning = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      h.handleRef.current!.unmountChild();
      await flushRealScheduling();
    } finally {
      actWarning.mockRestore();
    }
    // No request after unmount, no follow-up quota read, no terms side
    // effects (the gate's continuations were generation-killed at removal).
    expect(h.polishCalls).toHaveLength(0);
    expect(h.quotaCalls).toHaveLength(1);
  });

  it("unmount while request in flight: the operation is already aborted inside the unmount commit", async () => {
    const h = renderUnmountRace();
    act(() => {
      h.flow().open(SCOPE);
    });
    await act(async () => {
      h.quotaCalls[0].resolve({ requestId: "q-1", quota: makeQuota(5) });
      h.hasAcceptedCalls[0].resolve(true);
    });
    act(() => {
      h.flow().confirm();
    });
    expect(h.polishCalls).toHaveLength(1);
    expect(h.flow().state.phase).toBe("loading");
    const signal = h.polishCalls[0].signal;
    expect(signal?.aborted).toBe(false);
    // Inside the unmount commit the child must ALREADY be invalidated: with
    // a passive cleanup (pre-fix) the controller is not aborted yet when the
    // parent's layout effect runs.
    let abortedAtCommit: boolean | null = null;
    h.onCommitRef.current = () => {
      abortedAtCommit = signal?.aborted ?? null;
      h.polishCalls[0].deferred.resolve(successResponse(h.polishCalls[0].request, 4, "srv-A"));
    };
    const actWarning = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      h.handleRef.current!.unmountChild();
      await flushRealScheduling();
    } finally {
      actWarning.mockRestore();
    }
    expect(abortedAtCommit).toBe(true);
    // The late response applied nothing and triggered no follow-up reads.
    expect(h.quotaCalls).toHaveLength(1);
  });
});
