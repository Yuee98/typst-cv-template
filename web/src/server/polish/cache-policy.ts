import { resolveCachePolicy, type CachePolicyId } from "./adapter-registry";
import type { PolishInferenceRequestV2 } from "./inference-v2";
import {
  buildSystemPrompt,
  POLISH_PROMPT_VERSION,
  POLISH_STABLE_PROMPT_BLOCK_ID,
  POLISH_VARIABLE_PROMPT_BLOCK_ID,
} from "./prompt";

const PROFILE_VERSION_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const POLISH_PROMPT_TEMPLATE_ID = "resume-polish-v1" as const;
export const POLISH_OUTPUT_SCHEMA_VERSION = "polish-items-json-object-v1" as const;

export class PromptCachePolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PromptCachePolicyError";
  }
}

export interface PromptCacheKeyMaterialV1 {
  readonly schemaVersion: "prompt_cache_key_material_v1";
  readonly profileVersionId: string;
  readonly promptVersion: typeof POLISH_PROMPT_VERSION;
  readonly outputSchemaVersion: typeof POLISH_OUTPUT_SCHEMA_VERSION;
  readonly templateId: typeof POLISH_PROMPT_TEMPLATE_ID;
  readonly locale: "zh" | "en";
}

export interface AutomaticPromptCacheDecisionV1 {
  readonly schemaVersion: "prompt_cache_policy_decision_v1";
  readonly cachePolicyId: CachePolicyId;
  readonly mode: "automatic";
  readonly cacheWriteReporting: "unavailable";
  readonly boundaryAfter: typeof POLISH_STABLE_PROMPT_BLOCK_ID;
  /** Automatic profiles receive no explicit cache key, TTL, breakpoint, or padding parameters. */
  readonly upstreamCacheParameters: null;
  /** Safe canonical fields for a future hash/ledger reference; never prompt content or identity data. */
  readonly cacheKeyMaterial: PromptCacheKeyMaterialV1;
}

export interface ResolvePromptCachePolicyInput {
  cachePolicyId: string;
  profileVersionId: string;
  language: "zh" | "en";
  prompt: PolishInferenceRequestV2["prompt"];
}

function assertProfileVersion(input: ResolvePromptCachePolicyInput): void {
  if (!PROFILE_VERSION_ID_PATTERN.test(input.profileVersionId)) {
    throw new PromptCachePolicyError("profileVersionId must be an immutable UUID");
  }
}

function assertCanonicalPromptBoundary(input: ResolvePromptCachePolicyInput): void {
  const { blocks, explicitCacheBoundaryAfter } = input.prompt;
  if (blocks.length !== 2) {
    throw new PromptCachePolicyError("polish prompt must contain the canonical two-block layout");
  }

  const [stable, variable] = blocks;
  if (
    stable.id !== POLISH_STABLE_PROMPT_BLOCK_ID ||
    stable.role !== "developer" ||
    stable.stability !== "stable" ||
    stable.content !== buildSystemPrompt(input.language)
  ) {
    throw new PromptCachePolicyError("stable prompt prefix does not match the code-owned template");
  }
  if (
    variable.id !== POLISH_VARIABLE_PROMPT_BLOCK_ID ||
    variable.role !== "user" ||
    variable.stability !== "variable"
  ) {
    throw new PromptCachePolicyError("request content must be the variable prompt suffix");
  }
  if (explicitCacheBoundaryAfter !== POLISH_STABLE_PROMPT_BLOCK_ID) {
    throw new PromptCachePolicyError("cache boundary must follow the final stable prompt block");
  }
}

/**
 * Resolve the current automatic-cache policy without mutating or padding the
 * prompt. Unknown/future policy modes fail closed until their own reviewed
 * implementation is added.
 */
export function resolvePromptCachePolicy(
  input: ResolvePromptCachePolicyInput,
): AutomaticPromptCacheDecisionV1 {
  const registration = resolveCachePolicy(input.cachePolicyId);
  if (registration.mode !== "automatic" || registration.cacheWriteReporting !== "unavailable") {
    throw new PromptCachePolicyError("unsupported prompt cache policy registration");
  }

  assertProfileVersion(input);
  assertCanonicalPromptBoundary(input);

  return {
    schemaVersion: "prompt_cache_policy_decision_v1",
    cachePolicyId: registration.id,
    mode: "automatic",
    cacheWriteReporting: "unavailable",
    boundaryAfter: POLISH_STABLE_PROMPT_BLOCK_ID,
    upstreamCacheParameters: null,
    cacheKeyMaterial: {
      schemaVersion: "prompt_cache_key_material_v1",
      profileVersionId: input.profileVersionId.toLowerCase(),
      promptVersion: POLISH_PROMPT_VERSION,
      outputSchemaVersion: POLISH_OUTPUT_SCHEMA_VERSION,
      templateId: POLISH_PROMPT_TEMPLATE_ID,
      locale: input.language,
    },
  };
}
