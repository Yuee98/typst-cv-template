import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import type { RuntimeExecutionTargetV1 } from "./lifecycle-v2-contract";
import {
  DEEPSEEK_PROFILE_KEY,
  DEEPSEEK_REVIEWED_SOURCE_COMMIT_OID,
  DEEPSEEK_RUNTIME_CONTRACT_DB_FIXTURE_V1,
  DEEPSEEK_RUNTIME_EXECUTION_TARGET_V1,
  DEEPSEEK_RUNTIME_TARGET_RESOLVER_V1,
  DEEPSEEK_SERVICE_RUNTIME_CONTRACT_ID,
  DEEPSEEK_SERVICE_RUNTIME_CONTRACT_V1,
  DEEPSEEK_SERVICE_RUNTIME_CONTRACT_V1_SHA256,
  DEEPSEEK_SERVICE_RUNTIME_TARGET_ID,
  DEEPSEEK_SERVICE_RUNTIME_TARGET_SET_V1_SHA256,
  DEEPSEEK_SERVICE_RUNTIME_TARGET_V1_SHA256,
  validateServiceRuntimeContractV1Registry,
} from "./service-runtime-contract-v1";

const EXPECTED_FACT_IDS = [
  "fact.acceptance.authorization.v1",
  "fact.deepseek.adapter.wire.v1",
  "fact.deepseek.display.registration.v1",
  "fact.deepseek.display.selection.v1",
  "fact.deepseek.endpoint.resolution.v1",
  "fact.deepseek.endpoint.selection.v1",
  "fact.deepseek.gateway.service.v1",
  "fact.deepseek.model.selection.v1",
  "fact.deepseek.subject.derivation.v1",
  "fact.deepseek.subject.send.v1",
  "fact.deepseek.submitted.v1",
  "fact.deepseek.wire.selection.v1",
  "fact.material.reaccept.v1",
  "fact.neutral.ledger.v1",
  "fact.neutral.plaintext.v1",
  "fact.neutral.quota.v1",
  "fact.neutral.retention.v1",
  "fact.neutral.retry.v1",
  "fact.neutral.scope.v1",
  "fact.privacy.recipient.deepseek.v1",
  "fact.route.change-gate.v1",
  "fact.route.no-fallback.deepseek.v1",
  "fact.route.no-selector.v1",
  "fact.route.readonly.v1",
] as const;

const RUNTIME_SCHEMA_FIELDS = Object.freeze({
  ai_service_runtime_evidence_v1: Object.freeze([
    "schema_version",
    "runtime_evidence_id",
    "authority_kind",
    "supported_fact_id",
    "supported_fact_sha256",
    "source_repo_path",
    "source_git_blob_sha256",
  ]),
  ai_service_runtime_target_v1: Object.freeze([
    "schema_version",
    "runtime_target_id",
    "profile_key",
    "legal_manifest_id",
    "legal_manifest_sha256",
    "route_descriptor_id",
    "route_descriptor_sha256",
  ]),
  ai_service_runtime_contract_v1: Object.freeze([
    "schema_version",
    "runtime_contract_id",
    "reviewed_source_commit_oid",
    "legal_bundle_version",
    "bundle_contract_sha256",
    "runtime_target_ids",
    "runtime_target_sha256s",
    "service_fact_ids",
    "service_fact_sha256s",
    "runtime_evidence_ids",
    "runtime_evidence_sha256s",
  ]),
});

type Mutable<T> = T extends readonly (infer Item)[]
  ? Mutable<Item>[]
  : T extends object
    ? { -readonly [Key in keyof T]: Mutable<T[Key]> }
    : T;
type MutableRegistry = Mutable<typeof DEEPSEEK_SERVICE_RUNTIME_CONTRACT_V1>;

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (
    (typeof value !== "object" && typeof value !== "function") ||
    value === null ||
    seen.has(value as object)
  ) {
    return value;
  }
  seen.add(value as object);
  for (const key of Reflect.ownKeys(value as object)) {
    deepFreeze(Reflect.get(value as object, key), seen);
  }
  return Object.freeze(value);
}

function frozenCandidate(
  mutate: (candidate: MutableRegistry) => void,
): MutableRegistry {
  const candidate = structuredClone(
    DEEPSEEK_SERVICE_RUNTIME_CONTRACT_V1,
  ) as MutableRegistry;
  mutate(candidate);
  return deepFreeze(candidate);
}

function expectRegistryRejection(
  mutate: (candidate: MutableRegistry) => void,
  pattern?: RegExp,
): void {
  const action = () =>
    validateServiceRuntimeContractV1Registry(frozenCandidate(mutate));
  if (pattern === undefined) expect(action).toThrow();
  else expect(action).toThrow(pattern);
}

function independentRuntimeFingerprint(
  descriptor: Readonly<Record<string, unknown>>,
): string {
  const schemaVersion = descriptor.schema_version;
  if (
    typeof schemaVersion !== "string" ||
    !Object.hasOwn(RUNTIME_SCHEMA_FIELDS, schemaVersion)
  ) {
    throw new Error("unknown independent runtime schema");
  }
  const fields =
    RUNTIME_SCHEMA_FIELDS[
      schemaVersion as keyof typeof RUNTIME_SCHEMA_FIELDS
    ];
  const records = ["ai_fingerprint_record_v1\n"];
  const append = (key: string, scalar: string): void => {
    records.push(
      `${Buffer.byteLength(key, "utf8")}:${key}:${Buffer.byteLength(scalar, "utf8")}:${scalar}\n`,
    );
  };
  for (const field of fields) {
    const value = descriptor[field];
    if (Array.isArray(value)) {
      append(`${field}.count`, String(value.length));
      value.forEach((item, index) => {
        if (typeof item !== "string") throw new Error("non-string array item");
        append(`${field}.${index}`, item);
      });
    } else {
      if (typeof value !== "string") throw new Error("non-string scalar");
      append(field, value);
    }
  }
  return createHash("sha256").update(records.join(""), "utf8").digest("hex");
}

function independentRuntimeTargetSetFingerprint(
  targets: readonly {
    readonly descriptor: { readonly runtime_target_id: string };
    readonly sha256: string;
  }[],
): string {
  const bytes = [...targets]
    .sort((left, right) =>
      Buffer.compare(
        Buffer.from(left.descriptor.runtime_target_id, "utf8"),
        Buffer.from(right.descriptor.runtime_target_id, "utf8"),
      ),
    )
    .map(
      (target) =>
        `${Buffer.byteLength(target.descriptor.runtime_target_id, "utf8")}:${target.descriptor.runtime_target_id}:${target.sha256}`,
    )
    .join("\n");
  return createHash("sha256").update(bytes, "utf8").digest("hex");
}

interface GitResult {
  readonly status: number;
  readonly stdout: Buffer;
  readonly stderr: Buffer;
}

const REPO_ROOT_RESULT = spawnSync("git", ["rev-parse", "--show-toplevel"], {
  cwd: process.cwd(),
  encoding: "utf8",
  windowsHide: true,
});
if (REPO_ROOT_RESULT.status !== 0 || !REPO_ROOT_RESULT.stdout) {
  throw new Error("cannot resolve repository root for runtime source evidence");
}
const REPO_ROOT = REPO_ROOT_RESULT.stdout.trim();

function git(args: readonly string[]): GitResult {
  const result = spawnSync("git", args, {
    cwd: REPO_ROOT,
    encoding: null,
    windowsHide: true,
  });
  return {
    status: result.status ?? -1,
    stdout: result.stdout ?? Buffer.alloc(0),
    stderr: result.stderr ?? Buffer.alloc(0),
  };
}

interface ReviewedTreeEntry {
  readonly mode: "100644" | "100755";
  readonly objectId: string;
  readonly path: string;
}

function parseReviewedTreeEntry(line: string, expectedPath: string): ReviewedTreeEntry {
  const tab = line.indexOf("\t");
  if (tab < 0) throw new Error("unresolved reviewed source path");
  const [mode, type, objectId, ...extra] = line.slice(0, tab).split(" ");
  const path = line.slice(tab + 1);
  if (
    extra.length > 0 ||
    (mode !== "100644" && mode !== "100755") ||
    type !== "blob" ||
    !/^[0-9a-f]{40}$/u.test(objectId ?? "") ||
    path !== expectedPath
  ) {
    throw new Error("reviewed source must resolve to one exact regular Git blob");
  }
  return { mode, objectId, path };
}

let reviewedTreeLines: ReadonlyMap<string, string> | undefined;

function reviewedTreeLine(path: string): string {
  if (reviewedTreeLines === undefined) {
    const commit = DEEPSEEK_REVIEWED_SOURCE_COMMIT_OID.slice("sha1:".length);
    const listing = git(["ls-tree", "-r", "--full-tree", commit]);
    if (listing.status !== 0) throw new Error("reviewed source tree lookup failed");
    const entries = new Map<string, string>();
    for (const line of listing.stdout.toString("utf8").split("\n")) {
      if (line.length === 0) continue;
      const tab = line.indexOf("\t");
      if (tab >= 0) entries.set(line.slice(tab + 1), line);
    }
    reviewedTreeLines = entries;
  }
  const line = reviewedTreeLines.get(path);
  if (line === undefined) throw new Error("unresolved reviewed source path");
  return line;
}

function readReviewedBlob(path: string): Buffer {
  const entry = parseReviewedTreeEntry(reviewedTreeLine(path), path);
  const blob = git(["cat-file", "blob", entry.objectId]);
  if (blob.status !== 0) throw new Error("reviewed source blob cannot be read");
  return blob.stdout;
}

function cloneExecutionTarget(): Mutable<RuntimeExecutionTargetV1> {
  return structuredClone(
    DEEPSEEK_RUNTIME_EXECUTION_TARGET_V1,
  ) as Mutable<RuntimeExecutionTargetV1>;
}

describe("DeepSeek service runtime contract V1", () => {
  it("freezes exact reviewed roots, DB projection, and the 24-fact authority", () => {
    expect(() =>
      validateServiceRuntimeContractV1Registry(
        DEEPSEEK_SERVICE_RUNTIME_CONTRACT_V1,
      ),
    ).not.toThrow();
    expect(DEEPSEEK_SERVICE_RUNTIME_TARGET_V1_SHA256).toBe(
      "aa4948f6f0060a08ada1d0b831babd17c37287be02a9a8f2f9ec69c0f2bed119",
    );
    expect(DEEPSEEK_SERVICE_RUNTIME_CONTRACT_V1_SHA256).toBe(
      "a07228f777d4c61aacfb7ee452c100806c4b4c0eb996b3a639771891c0a9b79b",
    );
    expect(DEEPSEEK_SERVICE_RUNTIME_TARGET_SET_V1_SHA256).toBe(
      "5b7f5f2cd9d21c3c7409f02d7b65eda03999309c0ba3939e50fb81caca2c9340",
    );
    expect(
      DEEPSEEK_SERVICE_RUNTIME_CONTRACT_V1.requiredServiceFacts.map(
        (pair) => pair.id,
      ),
    ).toEqual(EXPECTED_FACT_IDS);
    expect(DEEPSEEK_SERVICE_RUNTIME_CONTRACT_V1.evidence).toHaveLength(48);
    expect(DEEPSEEK_RUNTIME_CONTRACT_DB_FIXTURE_V1).toMatchObject({
      contract: {
        runtimeContractId: DEEPSEEK_SERVICE_RUNTIME_CONTRACT_ID,
        runtimeContractSha256: DEEPSEEK_SERVICE_RUNTIME_CONTRACT_V1_SHA256,
        reviewedSourceCommitOid: DEEPSEEK_REVIEWED_SOURCE_COMMIT_OID,
        runtimeTargetSetSha256:
          DEEPSEEK_SERVICE_RUNTIME_TARGET_SET_V1_SHA256,
      },
      targets: [
        {
          runtimeTargetId: DEEPSEEK_SERVICE_RUNTIME_TARGET_ID,
          runtimeTargetSha256: DEEPSEEK_SERVICE_RUNTIME_TARGET_V1_SHA256,
          profileKey: DEEPSEEK_PROFILE_KEY,
        },
      ],
    });
    expect(Object.isFrozen(DEEPSEEK_RUNTIME_CONTRACT_DB_FIXTURE_V1)).toBe(true);
    expect(Object.isFrozen(DEEPSEEK_RUNTIME_CONTRACT_DB_FIXTURE_V1.targets)).toBe(
      true,
    );
  });

  it("independently reproduces every evidence, target, and contract fingerprint", () => {
    for (const item of DEEPSEEK_SERVICE_RUNTIME_CONTRACT_V1.evidence) {
      expect(
        independentRuntimeFingerprint(
          item.descriptor as unknown as Readonly<Record<string, unknown>>,
        ),
        item.descriptor.runtime_evidence_id,
      ).toBe(item.sha256);
    }
    const target = DEEPSEEK_SERVICE_RUNTIME_CONTRACT_V1.targets[0];
    expect(
      independentRuntimeFingerprint(
        target.descriptor as unknown as Readonly<Record<string, unknown>>,
      ),
    ).toBe(target.sha256);
    expect(
      independentRuntimeFingerprint(
        DEEPSEEK_SERVICE_RUNTIME_CONTRACT_V1.contract as unknown as Readonly<
          Record<string, unknown>
        >,
      ),
    ).toBe(DEEPSEEK_SERVICE_RUNTIME_CONTRACT_V1.contractSha256);
    expect(
      independentRuntimeTargetSetFingerprint(
        DEEPSEEK_SERVICE_RUNTIME_CONTRACT_V1.targets,
      ),
    ).toBe(DEEPSEEK_SERVICE_RUNTIME_TARGET_SET_V1_SHA256);
  });

  it("binds each required fact to exactly one implementation and one test descriptor", () => {
    const authority = new Map<string, string[]>();
    for (const item of DEEPSEEK_SERVICE_RUNTIME_CONTRACT_V1.evidence) {
      const descriptor = item.descriptor;
      expect(Object.keys(descriptor).sort()).toEqual(
        [
          "authority_kind",
          "runtime_evidence_id",
          "schema_version",
          "source_git_blob_sha256",
          "source_repo_path",
          "supported_fact_id",
          "supported_fact_sha256",
        ].sort(),
      );
      const current = authority.get(descriptor.supported_fact_id) ?? [];
      current.push(descriptor.authority_kind);
      authority.set(descriptor.supported_fact_id, current);
    }
    expect([...authority.keys()].sort()).toEqual([...EXPECTED_FACT_IDS].sort());
    for (const factId of EXPECTED_FACT_IDS) {
      expect(authority.get(factId)?.sort(), factId).toEqual([
        "service-implementation",
        "service-test",
      ]);
    }
  });

  it("resolves every source to exact regular blob bytes at the reviewed commit", () => {
    const cache = new Map<string, string>();
    for (const item of DEEPSEEK_SERVICE_RUNTIME_CONTRACT_V1.evidence) {
      const { source_repo_path: path, source_git_blob_sha256: expected } =
        item.descriptor;
      let actual = cache.get(path);
      if (actual === undefined) {
        actual = createHash("sha256").update(readReviewedBlob(path)).digest("hex");
        cache.set(path, actual);
      }
      expect(actual, path).toBe(expected);
    }
  }, 15_000);

  it("keeps the reviewed source at HEAD only before attestation files enter Git", () => {
    const reviewed = DEEPSEEK_REVIEWED_SOURCE_COMMIT_OID.slice("sha1:".length);
    const type = git(["cat-file", "-t", reviewed]);
    expect(type.status).toBe(0);
    expect(type.stdout.toString("utf8").trim()).toBe("commit");
    const head = git(["rev-parse", "HEAD"]);
    expect(head.status).toBe(0);
    const headOid = head.stdout.toString("utf8").trim();
    const ancestor = git(["merge-base", "--is-ancestor", reviewed, headOid]);
    expect(ancestor.status).toBe(0);
    if (headOid === reviewed) {
      expect(() =>
        readReviewedBlob(
          "web/src/server/polish/service-runtime-contract-v1.ts",
        ),
      ).toThrow(/unresolved/u);
      expect(() =>
        readReviewedBlob(
          "web/src/server/polish/service-runtime-contract-v1.test.ts",
        ),
      ).toThrow(/unresolved/u);
    } else {
      expect(headOid).not.toBe(reviewed);
    }
  });

  it("rejects unresolved, tree, symlink, submodule, self, and future source identities", () => {
    expect(() => readReviewedBlob("does/not/exist.ts")).toThrow(/unresolved/u);
    expect(() =>
      parseReviewedTreeEntry(
        `040000 tree ${"a".repeat(40)}\tweb/src/server/polish`,
        "web/src/server/polish",
      ),
    ).toThrow(/regular Git blob/u);
    expect(() =>
      parseReviewedTreeEntry(
        `120000 blob ${"a".repeat(40)}\tlink.ts`,
        "link.ts",
      ),
    ).toThrow(/regular Git blob/u);
    expect(() =>
      parseReviewedTreeEntry(
        `160000 commit ${"a".repeat(40)}\tvendor/repo`,
        "vendor/repo",
      ),
    ).toThrow(/regular Git blob/u);
    expect(() =>
      readReviewedBlob("web/src/server/polish/service-runtime-contract-v1.ts"),
    ).toThrow(/unresolved/u);
    expect(() =>
      readReviewedBlob("web/src/server/polish/handler-runtime-authority.ts.future"),
    ).toThrow(/unresolved/u);
  });

  it("rejects missing, extra, reordered, wrong-hash, and wrong-scope fact authority", () => {
    expectRegistryRejection((candidate) => {
      candidate.requiredServiceFacts.pop();
    }, /required service fact IDs/u);
    expectRegistryRejection((candidate) => {
      candidate.requiredServiceFacts.push({
        id: "fact.mimo.gateway.service.v1",
        sha256: "a".repeat(64),
      });
    }, /required service fact IDs/u);
    expectRegistryRejection((candidate) => {
      candidate.requiredServiceFacts.reverse();
    }, /required service fact IDs/u);
    expectRegistryRejection((candidate) => {
      candidate.requiredServiceFacts[0].sha256 = "a".repeat(64);
    }, /required service fact hashes/u);
    expectRegistryRejection((candidate) => {
      candidate.requiredServiceFacts[0].id = "fact.privacy.recipient.mimo.v1";
    }, /required service fact IDs/u);
  });

  it("rejects legal bundle, manifest, route, profile, and target identity drift", () => {
    expectRegistryRejection((candidate) => {
      candidate.legalBundleVersion = "future-bundle";
    }, /root identity/u);
    expectRegistryRejection((candidate) => {
      candidate.targets[0].descriptor.legal_manifest_id =
        "mimo-cn-2026-08-23-v1";
    }, /reviewed profile\/legal route/u);
    expectRegistryRejection((candidate) => {
      candidate.targets[0].descriptor.route_descriptor_id =
        "route.mimo.cn.official.v1";
    }, /reviewed profile\/legal route/u);
    expectRegistryRejection((candidate) => {
      candidate.targets[0].descriptor.profile_key =
        "mimo.cn.mimo-v2.5-pro.responses.v1";
    }, /reviewed profile\/legal route/u);
    expectRegistryRejection((candidate) => {
      candidate.targets[0].descriptor.runtime_target_id =
        "runtime-target.deepseek.rebound.v1";
    }, /reviewed profile\/legal route/u);
  });

  it("rejects evidence ID rebinding, hash drift, duplicates, and authority substitution", () => {
    expectRegistryRejection((candidate) => {
      candidate.evidence[0].descriptor.runtime_evidence_id =
        "runtime-evidence.rebound.v1";
    });
    expectRegistryRejection((candidate) => {
      candidate.evidence[0].sha256 = "a".repeat(64);
    }, /descriptor hash/u);
    expectRegistryRejection((candidate) => {
      candidate.evidence.push(structuredClone(candidate.evidence[0]));
    }, /sorted and unique|duplicate or rebound/u);
    for (const authority of ["provider-external", "service-display"] as const) {
      expectRegistryRejection((candidate) => {
        (
          candidate.evidence[0].descriptor as unknown as Record<string, unknown>
        ).authority_kind = authority;
      }, /forbidden authority/u);
    }
  });

  it.each([
    "../outside.ts",
    "web/src/../secret.ts",
    "web\\src\\server.ts",
    "C:/repo/file.ts",
    "//server/share/file.ts",
    "/absolute/file.ts",
    "web//src/file.ts",
  ])("rejects non-portable evidence path %s", (path) => {
    expectRegistryRejection((candidate) => {
      candidate.evidence[0].descriptor.source_repo_path = path;
    }, /portable repo-relative ASCII/u);
  });

  it.each([
    "web/src/server/polish/service-runtime-contract-v1.ts",
    "web/src/server/polish/service-runtime-contract-v1.test.ts",
    "web/src/server/polish/handler-runtime-authority.ts",
    "web/src/server/polish/handler-runtime-authority.test.ts",
  ])("rejects self or future evidence path %s", (path) => {
    expectRegistryRejection((candidate) => {
      candidate.evidence[0].descriptor.source_repo_path = path;
    }, /future binding files/u);
  });

  it("rejects root and pair-array hash drift instead of silently normalizing it", () => {
    expectRegistryRejection((candidate) => {
      candidate.contractSha256 = "a".repeat(64);
    }, /execution target identity|root hash/u);
    expectRegistryRejection((candidate) => {
      candidate.contract.runtime_target_sha256s[0] = "a".repeat(64);
    }, /contract target hashes/u);
    expectRegistryRejection((candidate) => {
      candidate.contract.runtime_evidence_sha256s.reverse();
    }, /contract evidence hashes/u);
    expectRegistryRejection((candidate) => {
      candidate.runtimeTargetSetSha256 = "a".repeat(64);
    }, /target-set hash/u);
  });

  it("requires deep freeze, exact prototypes, own data properties, and dense arrays", () => {
    const unfrozen = structuredClone(DEEPSEEK_SERVICE_RUNTIME_CONTRACT_V1);
    expect(() => validateServiceRuntimeContractV1Registry(unfrozen)).toThrow(
      /deeply frozen/u,
    );

    const customPrototype = structuredClone(
      DEEPSEEK_SERVICE_RUNTIME_CONTRACT_V1,
    ) as MutableRegistry;
    Object.setPrototypeOf(customPrototype, Object.freeze({ inherited: true }));
    deepFreeze(customPrototype);
    expect(() =>
      validateServiceRuntimeContractV1Registry(customPrototype),
    ).toThrow(/plain object/u);

    const getterCandidate = structuredClone(
      DEEPSEEK_SERVICE_RUNTIME_CONTRACT_V1,
    ) as MutableRegistry;
    const root = getterCandidate as unknown as Record<string, unknown>;
    delete root.schemaVersion;
    Object.defineProperty(root, "schemaVersion", {
      enumerable: true,
      configurable: true,
      get: () => "service_runtime_contract_registry_v1",
    });
    deepFreeze(getterCandidate);
    expect(() =>
      validateServiceRuntimeContractV1Registry(getterCandidate),
    ).toThrow(/own data property/u);

    const symbolCandidate = structuredClone(
      DEEPSEEK_SERVICE_RUNTIME_CONTRACT_V1,
    ) as MutableRegistry;
    (symbolCandidate as unknown as Record<PropertyKey, unknown>)[Symbol("extra")] =
      true;
    deepFreeze(symbolCandidate);
    expect(() =>
      validateServiceRuntimeContractV1Registry(symbolCandidate),
    ).toThrow(/symbol key/u);

    const sparse = structuredClone(
      DEEPSEEK_SERVICE_RUNTIME_CONTRACT_V1,
    ) as MutableRegistry;
    delete sparse.evidence[0];
    deepFreeze(sparse);
    expect(() => validateServiceRuntimeContractV1Registry(sparse)).toThrow(
      /sparse index/u,
    );

    const customArray = structuredClone(
      DEEPSEEK_SERVICE_RUNTIME_CONTRACT_V1,
    ) as MutableRegistry;
    Object.setPrototypeOf(
      customArray.evidence,
      Object.freeze(Object.create(Array.prototype) as object),
    );
    deepFreeze(customArray);
    expect(() => validateServiceRuntimeContractV1Registry(customArray)).toThrow(
      /exact array/u,
    );
  });
});

describe("DeepSeek runtime target resolver V1", () => {
  it("accepts only the exact reviewed runtime/profile/legal/route tuple", () => {
    expect(
      DEEPSEEK_RUNTIME_TARGET_RESOLVER_V1(
        DEEPSEEK_RUNTIME_EXECUTION_TARGET_V1,
      ),
    ).toBe(true);
    expect(DEEPSEEK_RUNTIME_TARGET_RESOLVER_V1(cloneExecutionTarget())).toBe(true);
  });

  it("rejects unknown contract, bundle, profile, manifest, version, and schema", () => {
    for (const [key, value] of [
      ["runtimeContractId", "runtime.unknown.v1"],
      ["runtimeContractSha256", "a".repeat(64)],
      ["legalBundleVersion", "future-bundle"],
      ["profileVersionId", "22222222-2222-4222-8222-222222222221"],
      ["profileKey", "mimo.cn.mimo-v2.5-pro.responses.v1"],
      ["legalManifestId", "mimo-cn-2026-08-23-v1"],
      ["schemaVersion", "RUNTIME_EXECUTION_TARGET_V1"],
    ] as const) {
      const target = cloneExecutionTarget();
      (target as unknown as Record<string, unknown>)[key] = value;
      expect(DEEPSEEK_RUNTIME_TARGET_RESOLVER_V1(target), key).toBe(false);
    }
  });

  it("rejects every nested route field drift without a compatible fallback", () => {
    for (const key of Object.keys(
      DEEPSEEK_RUNTIME_EXECUTION_TARGET_V1.routeDescriptor,
    )) {
      const target = cloneExecutionTarget();
      const route = target.routeDescriptor as unknown as Record<string, unknown>;
      route[key] = `${String(route[key])}.drift`;
      expect(DEEPSEEK_RUNTIME_TARGET_RESOLVER_V1(target), key).toBe(false);
    }
  });

  it("rejects missing, extra, inherited, partial, array, and null inputs", () => {
    const missing = cloneExecutionTarget();
    delete (missing as unknown as Record<string, unknown>).profileKey;
    expect(DEEPSEEK_RUNTIME_TARGET_RESOLVER_V1(missing)).toBe(false);

    const partial = {
      runtimeContractId: DEEPSEEK_SERVICE_RUNTIME_CONTRACT_ID,
      profileKey: DEEPSEEK_PROFILE_KEY,
    } as unknown as RuntimeExecutionTargetV1;
    expect(DEEPSEEK_RUNTIME_TARGET_RESOLVER_V1(partial)).toBe(false);

    const extra = cloneExecutionTarget();
    (extra as unknown as Record<string, unknown>).provider = "deepseek";
    expect(DEEPSEEK_RUNTIME_TARGET_RESOLVER_V1(extra)).toBe(false);

    const inherited = cloneExecutionTarget();
    Object.setPrototypeOf(inherited, { provider: "deepseek" });
    expect(DEEPSEEK_RUNTIME_TARGET_RESOLVER_V1(inherited)).toBe(false);

    expect(
      DEEPSEEK_RUNTIME_TARGET_RESOLVER_V1(
        [] as unknown as RuntimeExecutionTargetV1,
      ),
    ).toBe(false);
    expect(
      DEEPSEEK_RUNTIME_TARGET_RESOLVER_V1(
        null as unknown as RuntimeExecutionTargetV1,
      ),
    ).toBe(false);
  });
});
