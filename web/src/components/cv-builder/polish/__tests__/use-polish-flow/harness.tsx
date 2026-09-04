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
import { act, render } from "@testing-library/react";
import {
  createRef,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
  type RefObject,
} from "react";
import { useForm, type UseFormReturn } from "react-hook-form";
import { expect, vi } from "vitest";

import { DEFAULT_SECTION_ORDER, ORDERED_SECTION_IDS, type CvData } from "@/lib/cv/schema";
import type {
  PolishAvailabilityResponse,
  PolishLanguage,
  PolishPostRequest,
  PolishQuota,
  PolishQuotaResponse,
  PolishSuccessResponse,
} from "@/lib/polish/contract";

import { ENABLED_AVAILABILITY_BODY } from "../client/fixtures";
import {
  PolishApiError,
  type PolishApiClient,
  type PolishAuthenticatedRequestOptions,
} from "../../polish-client";
import { POLISH_TRANSPORT_ERROR_CODES } from "../../polish-errors";
import type { PolishScope } from "../../scope-builder";
import {
  usePolishFlow,
  type PolishFlow,
  type PolishTermsGateway,
} from "../../use-polish-flow";


// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

export const SCOPE: PolishScope = { sectionId: "skills", granularity: "section" };

export function bullet(body: string) {
  return { body };
}

export function makeCvData(): CvData {
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

export function makeSession(userId: string): Session {
  return {
    user: { id: userId },
    access_token: `token-${userId}`,
  } as unknown as Session;
}

export function makeQuota(remaining: number): PolishQuota {
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

export function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

export interface MakeClientOptions {
  /** Keep reads pending so ownership/invalidation can be driven explicitly. */
  deferAvailability?: boolean;
  availabilityResponse?: PolishAvailabilityResponse;
}

export function makeClient(options: MakeClientOptions = {}) {
  const polishCalls: Array<{
    request: PolishPostRequest;
    deferred: Deferred<PolishSuccessResponse>;
    signal: AbortSignal | undefined;
    expectedUserId: string;
  }> = [];
  // Compatibility name for existing ownership tests: these deferred booleans
  // now resolve the exact availability snapshot's termsAccepted bit. There is
  // no separate production terms query after UX-004.
  const hasAcceptedCalls: Array<Deferred<boolean>> = [];
  const availabilityCalls: Array<{
    deferred: Deferred<PolishAvailabilityResponse>;
    signal: AbortSignal | undefined;
    expectedUserId: string;
  }> = [];
  const quotaCalls: Array<Deferred<PolishQuotaResponse>> = [];
  const quotaOwners: string[] = [];
  const client: PolishApiClient = {
    polish: vi.fn((request: PolishPostRequest, requestOptions: PolishAuthenticatedRequestOptions) => {
      const call = deferred<PolishSuccessResponse>();
      polishCalls.push({
        request,
        deferred: call,
        signal: requestOptions.signal,
        expectedUserId: requestOptions.expectedUserId,
      });
      return call.promise;
    }),
    getAvailability: vi.fn((requestOptions: PolishAuthenticatedRequestOptions) => {
      const call = deferred<PolishAvailabilityResponse>();
      availabilityCalls.push({
        deferred: call,
        signal: requestOptions.signal,
        expectedUserId: requestOptions.expectedUserId,
      });
      if (!options.deferAvailability) {
        const accepted = deferred<boolean>();
        hasAcceptedCalls.push(accepted);
        void accepted.promise.then(
          (termsAccepted) => {
            const response = options.availabilityResponse ?? ENABLED_AVAILABILITY_BODY;
            call.resolve(
              response.availability.enabled
                ? {
                    ...response,
                    availability: { ...response.availability, termsAccepted },
                  }
                : response,
            );
          },
          (reason) => call.reject(reason),
        );
      }
      return call.promise;
    }),
    getQuota: vi.fn((_requestOptions: PolishAuthenticatedRequestOptions) => {
      const call = deferred<PolishQuotaResponse>();
      quotaCalls.push(call);
      quotaOwners.push(_requestOptions.expectedUserId);
      return call.promise;
    }),
  };
  return {
    client,
    polishCalls,
    availabilityCalls,
    hasAcceptedCalls,
    quotaCalls,
    quotaOwners,
  };
}

export function makeTermsGateway() {
  type AcceptOptions = Parameters<PolishTermsGateway["accept"]>[0];
  const acceptCalls: Array<Deferred<void> & AcceptOptions> = [];
  const termsGateway: PolishTermsGateway = {
    accept: vi.fn((options: AcceptOptions) => {
      const call = deferred<void>();
      acceptCalls.push({ ...call, ...options });
      return call.promise;
    }),
  };
  return { termsGateway, acceptCalls };
}

export function successResponse(
  request: PolishPostRequest,
  remaining: number,
  requestId = "srv-req-1",
): PolishSuccessResponse {
  return {
    requestId,
    items: request.items.map((item) => ({ id: item.id, polished: `润色：${item.text}` })),
    quota: makeQuota(remaining),
  };
}

export function abortError(): PolishApiError {
  return new PolishApiError({ code: POLISH_TRANSPORT_ERROR_CODES.requestAborted });
}

// ---------------------------------------------------------------------------
// harness
// ---------------------------------------------------------------------------

export interface HarnessHandle {
  flow: PolishFlow | null;
  form: UseFormReturn<CvData> | null;
}

export interface HarnessProps {
  handleRef: RefObject<HarnessHandle | null>;
  documentId: string | null;
  language: PolishLanguage;
  session: Session | null;
  client: PolishApiClient;
  termsGateway: PolishTermsGateway;
}

export function Harness({
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

export function renderHarness(
  overrides?: Partial<Omit<HarnessProps, "handleRef">>,
  clientOptions?: MakeClientOptions,
) {
  const handleRef = createRef<HarnessHandle>();
  const {
    client,
    polishCalls,
    availabilityCalls,
    hasAcceptedCalls,
    quotaCalls,
    quotaOwners,
  } = makeClient(clientOptions);
  const { termsGateway, acceptCalls } = makeTermsGateway();
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
    availabilityCalls,
    quotaCalls,
    quotaOwners,
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
export async function openAccepted(h: ReturnType<typeof renderHarness>, scope: PolishScope = SCOPE) {
  act(() => {
    h.flow().open(scope);
  });
  expect(h.quotaCalls).toHaveLength(1);
  expect(h.hasAcceptedCalls).toHaveLength(1);
  expect(h.availabilityCalls).toHaveLength(1);
  await act(async () => {
    h.quotaCalls[0].resolve({ requestId: "q-1", quota: makeQuota(5) });
    h.hasAcceptedCalls[0].resolve(true);
  });
  expect(h.flow().terms.status).toBe("accepted");
  expect(h.flow().availabilityStatus).toBe("ready");
  expect(h.flow().canConfirm).toBe(true);
}

/** Open with terms NOT accepted, tick the checkbox, and start confirm(). */
export async function openRequiredAndConfirm(h: ReturnType<typeof renderHarness>) {
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
export async function openAndReachPreview(h: ReturnType<typeof renderHarness>) {
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



export interface RaceParentHandle {
  flow: PolishFlow | null;
  form: UseFormReturn<CvData> | null;
  switchSession: (userId: string) => void;
  switchDocument: (documentId: string) => void;
  switchLanguage: (language: PolishLanguage) => void;
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
export function RaceParent({
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
  const [language, setLanguage] = useState<PolishLanguage>("zh");
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
  const committedRef = useRef<{
    userId: string;
    documentId: string;
    language: PolishLanguage;
  } | null>(null);
  useLayoutEffect(() => {
    const committed = { userId: session.user.id, documentId, language };
    const previous = committedRef.current;
    committedRef.current = committed;
    if (
      previous !== null &&
      (previous.userId !== committed.userId ||
        previous.documentId !== committed.documentId ||
        previous.language !== committed.language)
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
    switchLanguage: (next: PolishLanguage) => setLanguage(next),
  }));
  return null;
}

export function renderRaceParent() {
  const handleRef = createRef<RaceParentHandle>();
  const { client, polishCalls, hasAcceptedCalls, quotaCalls } = makeClient();
  const { termsGateway, acceptCalls } = makeTermsGateway();
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
export async function flushRealScheduling() {
  await Promise.resolve();
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}


export interface UnmountRaceChildHandle {
  flow: PolishFlow | null;
  form: UseFormReturn<CvData> | null;
}

export interface UnmountRaceHandle {
  flow: PolishFlow | null;
  form: UseFormReturn<CvData> | null;
  unmountChild: () => void;
}

export function UnmountRaceChild({
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
export function UnmountRaceParent({
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

export function renderUnmountRace() {
  const handleRef = createRef<UnmountRaceHandle>();
  const { client, polishCalls, hasAcceptedCalls, quotaCalls } = makeClient();
  const { termsGateway, acceptCalls } = makeTermsGateway();
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
