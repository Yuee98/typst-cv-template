import {
  createCodeOwnedPolishAdapterResolverV2,
  type PolishAdapterResolverV2,
} from "./lifecycle-v2";
import {
  EMPTY_RUNTIME_TARGET_RESOLVER_V1,
  type RuntimeTargetResolverV1,
} from "./lifecycle-v2-contract";

type ServerEnvironment = Readonly<Record<string, string | undefined>>;

export interface RealPolishRuntimeAuthorityV2 {
  readonly runtimeTargetResolver: RuntimeTargetResolverV1;
  readonly resolveProvider: PolishAdapterResolverV2;
}

/**
 * Real Supabase composition before RT-009A.
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
    // RT-009A replaces this with the exact reviewed runtime evidence registry.
    // Until then, an accidentally active DB route releases before attempt
    // admission or provider resolution.
    runtimeTargetResolver: EMPTY_RUNTIME_TARGET_RESOLVER_V1,
    resolveProvider: createCodeOwnedPolishAdapterResolverV2({ env }),
  });
}
