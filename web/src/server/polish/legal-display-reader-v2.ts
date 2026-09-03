import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import {
  parseLegalDisplayV2,
  type LegalDisplayV2,
} from "@/lib/legal/legal-display-v2";

export class LegalDisplayV2ReadError extends Error {
  constructor(cause: unknown) {
    super("AI legal display read failed", { cause });
    this.name = "LegalDisplayV2ReadError";
  }
}

export async function readLegalDisplayV2(
  client: Pick<SupabaseClient, "rpc">,
  input: {
    legalBundleVersion: string;
    displayDisclosureKey: string;
  },
): Promise<LegalDisplayV2> {
  const { data, error } = await client.rpc("get_ai_legal_display_v2", {
    p_legal_bundle_version: input.legalBundleVersion,
    p_display_disclosure_key: input.displayDisclosureKey,
  });
  if (error) throw new LegalDisplayV2ReadError(error);
  try {
    const display = parseLegalDisplayV2(data);
    if (
      display.legalBundleVersion !== input.legalBundleVersion ||
      display.displayDisclosureKey !== input.displayDisclosureKey
    ) {
      throw new Error("AI legal display identity mismatch");
    }
    return display;
  } catch (cause) {
    throw new LegalDisplayV2ReadError(cause);
  }
}
