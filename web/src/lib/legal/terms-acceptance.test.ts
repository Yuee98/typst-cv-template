import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it, vi } from "vitest";

import {
  AI_LEGAL_BUNDLE_VERSION,
  AI_TERMS_VERSION,
} from "@/content/legal";
import {
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

  return {
    client: { from } as unknown as SupabaseClient,
    from,
    table,
    selectChain,
    upsert,
  };
}

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
      acceptAiLegalBundle(harness.client, AI_LEGAL_BUNDLE_VERSION),
    ).resolves.toBeUndefined();
    expect(harness.from).toHaveBeenCalledWith("user_terms_acceptances");
    expect(harness.upsert).toHaveBeenCalledWith(
      {
        document_key: "ai_terms",
        version: AI_LEGAL_BUNDLE_VERSION,
      },
      {
        ignoreDuplicates: true,
        onConflict: "user_id,document_key,version",
      },
    );

    const current = createTermsClient();
    await expect(acceptCurrentAiTerms(current.client)).resolves.toBeUndefined();
    expect(current.upsert).toHaveBeenCalledWith(
      {
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
      acceptAiLegalBundle(unknown.client, "2026-08-04"),
    ).rejects.toThrow("Unknown AI legal bundle version.");
    expect(unknown.from).not.toHaveBeenCalled();

    const failure = new Error("write failed");
    const rejected = createTermsClient({ upsertError: failure });
    await expect(
      acceptAiLegalBundle(rejected.client, AI_LEGAL_BUNDLE_VERSION),
    ).rejects.toBe(failure);
  });
});
