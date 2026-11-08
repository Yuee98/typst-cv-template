import type { LegalDisplay } from "./legal-display";
import type { CurrentTerms } from "./terms-acceptance";

type TermsTarget = Pick<CurrentTerms, "external_id" | "content_digest">;
type DisclosureTarget = Pick<LegalDisplay, "bundleId" | "manifestDigest" | "disclosureId" | "contentDigest">;

export function termsDocumentHref(target: TermsTarget): string {
  const query = new URLSearchParams({ document: target.external_id, digest: target.content_digest });
  return `/terms?${query}`;
}

export function aiDisclosureHref(target: DisclosureTarget): string {
  const query = new URLSearchParams({
    bundle: target.bundleId,
    manifest: target.manifestDigest,
    disclosure: target.disclosureId,
    digest: target.contentDigest,
  });
  return `/ai-terms?${query}`;
}

export type LegalReadTarget =
  | { type: "current" }
  | { type: "terms"; documentId: string; contentDigest: string }
  | { type: "disclosure"; bundleId: string; manifestDigest: string; disclosureId: string; contentDigest: string }
  | { type: "invalid" };

type Query = Pick<URLSearchParams, "get" | "getAll" | "has">;
const pinKeys = ["document", "digest", "bundle", "manifest", "disclosure"];
const digest = /^[0-9a-f]{64}$/;
const externalId = (value: string, prefix: string) => new RegExp(`^${prefix}_[0-9A-HJKMNP-TV-Z]{12}$`).test(value);

/** A partial or ambiguous pinned link must never silently show another version. */
export function parseLegalReadTarget(kind: "terms" | "ai_terms", query: Query): LegalReadTarget {
  if (!pinKeys.some(key => query.has(key))) return { type: "current" };
  const required = kind === "terms" ? ["document", "digest"] : ["bundle", "manifest", "disclosure", "digest"];
  if (pinKeys.some(key => query.has(key) && !required.includes(key)) || required.some(key => query.getAll(key).length !== 1)) {
    return { type: "invalid" };
  }
  const contentDigest = query.get("digest")!;
  if (!digest.test(contentDigest)) return { type: "invalid" };
  if (kind === "terms") {
    const documentId = query.get("document")!;
    return externalId(documentId, "ldv") ? { type: "terms", documentId, contentDigest } : { type: "invalid" };
  }
  const bundleId = query.get("bundle")!;
  const disclosureId = query.get("disclosure")!;
  const manifestDigest = query.get("manifest")!;
  return externalId(bundleId, "lgb") && externalId(disclosureId, "lds") && digest.test(manifestDigest)
    ? { type: "disclosure", bundleId, manifestDigest, disclosureId, contentDigest }
    : { type: "invalid" };
}
