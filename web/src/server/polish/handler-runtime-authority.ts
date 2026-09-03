import {
  createCodeOwnedPolishAdapterResolverV2,
  type PolishAdapterResolverV2,
} from "./lifecycle-v2";
import {
  type RuntimeTargetResolverV1,
} from "./lifecycle-v2-contract";
import {
  EMPTY_RUNTIME_TARGET_RESOLVER_V2,
  type RuntimeTargetResolverV2,
} from "./execution-snapshot-v2";
import {
  DEEPSEEK_MIMO_RUNTIME_TARGET_RESOLVER_V1,
  DEEPSEEK_RUNTIME_TARGET_RESOLVER_V1,
} from "./service-runtime-contract-v1";

type ServerEnvironment = Readonly<Record<string, string | undefined>>;

export interface RealPolishRuntimeAuthorityV2 {
  readonly runtimeTargetResolver: RuntimeTargetResolverV1;
  readonly runtimeTargetResolverV2: RuntimeTargetResolverV2;
  readonly resolveProvider: PolishAdapterResolverV2;
}

const REAL_POLISH_RUNTIME_TARGET_RESOLVER_V2: RuntimeTargetResolverV1 =
  (target) =>
    DEEPSEEK_RUNTIME_TARGET_RESOLVER_V1(target) ||
    DEEPSEEK_MIMO_RUNTIME_TARGET_RESOLVER_V1(target);

/**
 * Real Supabase composition after RT-009A.
 *
 * A deterministic provider is authority only inside the separate two-flag
 * fake-backend composition. Mixing it into a real accounting backend would
 * let synthetic output settle under a DB-frozen provider route, so the legacy
 * single fake-LLM mode is deliberately unsupported for the public V2 handler.
 */
export function createRealPolishRuntimeAuthorityV2(
  env: ServerEnvironment,
): RealPolishRuntimeAuthorityV2 {
  if (env.POLISH_FAKE_LLM === "true") {
    throw new Error(
      "POLISH_FAKE_LLM=true requires POLISH_FAKE_BACKEND=true for the V2 polish handler.",
    );
  }

  return Object.freeze({
    // Preserve the legacy DeepSeek target for in-flight/rollback execution
    // while admitting only the exact current combined-v2 target pair.
    runtimeTargetResolver: REAL_POLISH_RUNTIME_TARGET_RESOLVER_V2,
    // V2 profile rows remain dark until I06 binds the running build and
    // deployment-manifest report to the I05 target evidence. Parsing and DB
    // evidence alone do not authorize sends.
    runtimeTargetResolverV2: EMPTY_RUNTIME_TARGET_RESOLVER_V2,
    resolveProvider: createCodeOwnedPolishAdapterResolverV2({ env }),
  });
}
