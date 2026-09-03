import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it, vi } from "vitest";

import {
  AI_LEGAL_BUNDLE_VERSION,
  AI_TERMS_VERSION,
} from "@/content/legal";
import {
  acceptAiLegalDisclosureV2,
  acceptAiLegalBundle,
  acceptCurrentAiTerms,
  AI_LEGAL_BUNDLE_TERMS_VERSION_MAP,
  hasAcceptedAiLegalBundle,
  hasAcceptedCurrentAiTerms,
  parseKnownAiLegalBundleVersion,
} from "./terms-acceptance";

interface QueryResult {
  readonly data: unknown;
  readonly error: unknown;
}

function createTermsClient(options: {
  readonly queryResult?: QueryResult;
  readonly upsertError?: unknown;
  readonly sessionUserId?: string | null;
  readonly sessionError?: unknown;
  readonly rpcResult?: QueryResult;
} = {}) {
  const maybeSingle = vi.fn(async () =>
    options.queryResult ?? { data: null, error: null },
  );
  const selectChain = {
    eq: vi.fn(),
    maybeSingle,
  };
  selectChain.eq.mockReturnValue(selectChain);

  const upsert = vi.fn(async () => ({ error: options.upsertError ?? null }));
  const table = {
    select: vi.fn(() => selectChain),
    upsert,
  };
  const from = vi.fn(() => table);
  const getSession = vi.fn(async () => ({
    data: {
      session:
        options.sessionUserId === null
          ? null
          : { user: { id: options.sessionUserId ?? "user-a" } },
    },
    error: options.sessionError ?? null,
  }));
  const rpc = vi.fn(async () =>
    options.rpcResult ?? { data: null, error: null },
  );

  return {
    client: { auth: { getSession }, from, rpc } as unknown as SupabaseClient,
    from,
    table,
    selectChain,
    upsert,
    getSession,
    rpc,
  };
}

const V2_DISPLAY = {
  schemaVersion: "legal_display_v2" as const,
  displayDisclosureKey: "provider-v2",
  legalBundleVersion: "bundle-v2",
  legalManifestId: "manifest-v2",
  providerId: "00000000-0000-4000-8000-000000000001",
  recipientKey: "provider-recipient",
  modelId: "model-v2",
  contentSha256: "a".repeat(64),
  factIds: ["fact.provider.v2"],
  evidenceIds: ["evidence.provider.v2"],
  zh: {
    providerLabel: "提供方",
    modelLabel: "模型",
    blocks: [{ kind: "paragraph" as const, text: "中文说明。" }],
  },
  en: {
    providerLabel: "Provider",
    modelLabel: "Model",
    blocks: [{ kind: "paragraph" as const, text: "English disclosure." }],
  },
};

describe("AI legal bundle acceptance", () => {
  it("maps only the exact current bundle to the exact AI terms version", () => {
    expect(AI_LEGAL_BUNDLE_TERMS_VERSION_MAP).toEqual({
      [AI_LEGAL_BUNDLE_VERSION]: AI_TERMS_VERSION,
    });
    expect(parseKnownAiLegalBundleVersion(AI_LEGAL_BUNDLE_VERSION)).toBe(
      AI_LEGAL_BUNDLE_VERSION,
    );

    for (const value of [
      "2026-08-02",
      "2026-08-04",
      "2026-08-23-multi-provider-v2",
      ` ${AI_LEGAL_BUNDLE_VERSION}`,
      `${AI_LEGAL_BUNDLE_VERSION} `,
      AI_LEGAL_BUNDLE_VERSION.toUpperCase(),
      "",
      null,
      1,
      {},
    ]) {
      expect(() => parseKnownAiLegalBundleVersion(value)).toThrow(
        "Unknown AI legal bundle version.",
      );
    }
  });

  it("queries only the exact ai_terms bundle and reports row presence", async () => {
    const present = createTermsClient({
      queryResult: {
        data: { accepted_at: "2026-08-25T00:00:00.000Z", version: AI_TERMS_VERSION },
        error: null,
      },
    });

    await expect(
      hasAcceptedAiLegalBundle(present.client, AI_LEGAL_BUNDLE_VERSION),
    ).resolves.toBe(true);
    expect(present.from).toHaveBeenCalledWith("user_terms_acceptances");
    expect(present.table.select).toHaveBeenCalledWith("accepted_at,version");
    expect(present.selectChain.eq.mock.calls).toEqual([
      ["document_key", "ai_terms"],
      ["version", AI_LEGAL_BUNDLE_VERSION],
    ]);
    expect(present.selectChain.maybeSingle).toHaveBeenCalledOnce();

    const absent = createTermsClient();
    await expect(
      hasAcceptedCurrentAiTerms(absent.client),
    ).resolves.toBe(false);
    expect(absent.selectChain.eq.mock.calls.at(-1)).toEqual([
      "version",
      AI_TERMS_VERSION,
    ]);
  });

  it("fails closed before querying unknown or stale bundle versions", async () => {
    const harness = createTermsClient();

    await expect(
      hasAcceptedAiLegalBundle(harness.client, "2026-08-04"),
    ).rejects.toThrow("Unknown AI legal bundle version.");
    expect(harness.from).not.toHaveBeenCalled();
  });

  it("propagates acceptance-query failures", async () => {
    const failure = new Error("query failed");
    const harness = createTermsClient({
      queryResult: { data: null, error: failure },
    });

    await expect(
      hasAcceptedAiLegalBundle(harness.client, AI_LEGAL_BUNDLE_VERSION),
    ).rejects.toBe(failure);
  });

  it("writes the exact candidate bundle with the existing idempotency key", async () => {
    const harness = createTermsClient();

    await expect(
      acceptAiLegalBundle(harness.client, AI_LEGAL_BUNDLE_VERSION, "user-a"),
    ).resolves.toBeUndefined();
    expect(harness.from).toHaveBeenCalledWith("user_terms_acceptances");
    expect(harness.upsert).toHaveBeenCalledWith(
      {
        user_id: "user-a",
        document_key: "ai_terms",
        version: AI_LEGAL_BUNDLE_VERSION,
      },
      {
        ignoreDuplicates: true,
        onConflict: "user_id,document_key,version",
      },
    );

    const current = createTermsClient();
    await expect(acceptCurrentAiTerms(current.client, "user-a")).resolves.toBeUndefined();
    expect(current.upsert).toHaveBeenCalledWith(
      {
        user_id: "user-a",
        document_key: "ai_terms",
        version: AI_TERMS_VERSION,
      },
      {
        ignoreDuplicates: true,
        onConflict: "user_id,document_key,version",
      },
    );
  });

  it("rejects unknown versions before writes and propagates write failures", async () => {
    const unknown = createTermsClient();
    await expect(
      acceptAiLegalBundle(unknown.client, "2026-08-04", "user-a"),
    ).rejects.toThrow("Unknown AI legal bundle version.");
    expect(unknown.from).not.toHaveBeenCalled();

    const failure = new Error("write failed");
    const rejected = createTermsClient({ upsertError: failure });
    await expect(
      acceptAiLegalBundle(rejected.client, AI_LEGAL_BUNDLE_VERSION, "user-a"),
    ).rejects.toBe(failure);
  });

  it("fails closed before writing when the authenticated principal drifted", async () => {
    const drifted = createTermsClient({ sessionUserId: "user-b" });

    await expect(
      acceptAiLegalBundle(drifted.client, AI_LEGAL_BUNDLE_VERSION, "user-a"),
    ).rejects.toThrow("Authenticated user changed");
    expect(drifted.from).not.toHaveBeenCalled();
  });

  it("accepts the exact V2 display through the authenticated successor RPC", async () => {
    const harness = createTermsClient({
      rpcResult: {
        data: {
          schemaVersion: "ai_legal_acceptance_v2",
          legalBundleVersion: V2_DISPLAY.legalBundleVersion,
          displayDisclosureKey: V2_DISPLAY.displayDisclosureKey,
          contentSha256: V2_DISPLAY.contentSha256,
          accepted: true,
        },
        error: null,
      },
    });

    await expect(
      acceptAiLegalDisclosureV2(harness.client, {
        expectedUserId: "user-a",
        legalDisplay: V2_DISPLAY,
      }),
    ).resolves.toBeUndefined();
    expect(harness.rpc).toHaveBeenCalledWith(
      "accept_ai_legal_disclosure_v2",
      {
        p_expected_user_id: "user-a",
        p_legal_bundle_version: "bundle-v2",
        p_display_disclosure_key: "provider-v2",
        p_content_sha256: "a".repeat(64),
      },
    );
    expect(harness.from).not.toHaveBeenCalled();
  });

  it("rejects V2 account drift, forged displays and crossed receipts", async () => {
    const drifted = createTermsClient({ sessionUserId: "user-b" });
    await expect(
      acceptAiLegalDisclosureV2(drifted.client, {
        expectedUserId: "user-a",
        legalDisplay: V2_DISPLAY,
      }),
    ).rejects.toThrow("Authenticated user changed");
    expect(drifted.rpc).not.toHaveBeenCalled();

    const forged = createTermsClient();
    await expect(
      acceptAiLegalDisclosureV2(forged.client, {
        expectedUserId: "user-a",
        legalDisplay: { ...V2_DISPLAY, contentSha256: "unsafe" },
      }),
    ).rejects.toThrow();
    expect(forged.getSession).not.toHaveBeenCalled();

    const crossed = createTermsClient({
      rpcResult: {
        data: {
          schemaVersion: "ai_legal_acceptance_v2",
          legalBundleVersion: "crossed-bundle",
          displayDisclosureKey: V2_DISPLAY.displayDisclosureKey,
          contentSha256: V2_DISPLAY.contentSha256,
          accepted: true,
        },
        error: null,
      },
    });
    await expect(
      acceptAiLegalDisclosureV2(crossed.client, {
        expectedUserId: "user-a",
        legalDisplay: V2_DISPLAY,
      }),
    ).rejects.toThrow("Invalid AI legal acceptance receipt");
  });
});
