import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it, vi } from "vitest";

import {
  LegalDisplayV2ReadError,
  readLegalDisplayV2,
} from "./legal-display-reader-v2";

const DISPLAY = {
  schemaVersion: "legal_display_v2",
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
    blocks: [{ kind: "paragraph", text: "中文说明。" }],
  },
  en: {
    providerLabel: "Provider",
    modelLabel: "Model",
    blocks: [{ kind: "paragraph", text: "English disclosure." }],
  },
};

describe("legal display v2 reader", () => {
  it("reads and verifies the exact requested display identity", async () => {
    const rpc = vi.fn(async () => ({ data: DISPLAY, error: null }));
    await expect(
      readLegalDisplayV2({ rpc } as unknown as SupabaseClient, {
        legalBundleVersion: "bundle-v2",
        displayDisclosureKey: "provider-v2",
      }),
    ).resolves.toEqual(DISPLAY);
    expect(rpc).toHaveBeenCalledWith("get_ai_legal_display_v2", {
      p_legal_bundle_version: "bundle-v2",
      p_display_disclosure_key: "provider-v2",
    });
  });

  it("wraps DB errors and rejects crossed or malformed projections", async () => {
    const dbError = new Error("private DB error");
    await expect(
      readLegalDisplayV2(
        {
          rpc: vi.fn(async () => ({ data: null, error: dbError })),
        } as unknown as SupabaseClient,
        {
          legalBundleVersion: "bundle-v2",
          displayDisclosureKey: "provider-v2",
        },
      ),
    ).rejects.toMatchObject({
      name: "LegalDisplayV2ReadError",
      cause: dbError,
    });

    await expect(
      readLegalDisplayV2(
        {
          rpc: vi.fn(async () => ({
            data: { ...DISPLAY, legalBundleVersion: "crossed-bundle" },
            error: null,
          })),
        } as unknown as SupabaseClient,
        {
          legalBundleVersion: "bundle-v2",
          displayDisclosureKey: "provider-v2",
        },
      ),
    ).rejects.toBeInstanceOf(LegalDisplayV2ReadError);
  });
});
