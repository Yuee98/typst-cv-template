import type { LegalDisplay, LegalDocumentTarget } from "./legal-display";
import { legalDigestSchema, legalExternalIdSchema, legalIdSchema } from "./legal-display";
type ReadPin = Pick<LegalDocumentTarget, "external_id" | "document_audit_id" | "content_digest">;
export function termsDocumentHref(target: ReadPin): string {
  return `/terms?${new URLSearchParams({
    document: target.external_id,
    audit: target.document_audit_id,
    digest: target.content_digest
  })}`;
}
export function aiDisclosureHref(target: Pick<LegalDisplay, "common" | "provider">): string {
  return `/ai-terms?${new URLSearchParams({
    common: target.common.external_id,
    common_audit: target.common.document_audit_id,
    common_digest: target.common.content_digest,
    provider: target.provider.external_id,
    provider_audit: target.provider.document_audit_id,
    provider_digest: target.provider.content_digest
  })}`;
}
export type LegalReadTarget = {
  type: "current";
} | {
  type: "terms";
  document: ReadPin;
} | {
  type: "provider";
  common: ReadPin;
  provider: ReadPin;
} | {
  type: "invalid";
};
type Query = Pick<URLSearchParams, "get" | "getAll" | "has">;
const pinKeys = ["document", "audit", "digest", "common", "common_audit", "common_digest", "provider", "provider_audit", "provider_digest"];
export function parseLegalReadTarget(kind: "terms" | "ai_terms", query: Query): LegalReadTarget {
  if (["bundle", "manifest", "disclosure"].some(key => query.has(key))) return {
    type: "invalid"
  };
  if (!pinKeys.some(key => query.has(key))) return {
    type: "current"
  };
  const required = kind === "terms" ? ["document", "audit", "digest"] : ["common", "common_audit", "common_digest", "provider", "provider_audit", "provider_digest"];
  if (pinKeys.some(key => query.has(key) && !required.includes(key)) || required.some(key => query.getAll(key).length !== 1)) return {
    type: "invalid"
  };
  function pin(id: string, audit: string, digest: string): ReadPin | null {
    const external_id = query.get(id),
      document_audit_id = query.get(audit),
      content_digest = query.get(digest);
    return legalExternalIdSchema.safeParse(external_id).success && legalIdSchema.safeParse(document_audit_id).success && legalDigestSchema.safeParse(content_digest).success ? {
      external_id: external_id!,
      document_audit_id: document_audit_id!,
      content_digest: content_digest!
    } : null;
  }
  if (kind === "terms") {
    const document = pin("document", "audit", "digest");
    return document ? {
      type: "terms",
      document
    } : {
      type: "invalid"
    };
  }
  const common = pin("common", "common_audit", "common_digest"),
    provider = pin("provider", "provider_audit", "provider_digest");
  return common && provider ? {
    type: "provider",
    common,
    provider
  } : {
    type: "invalid"
  };
}
