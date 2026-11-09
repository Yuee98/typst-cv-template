"use client";

import { Suspense, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import { Link } from "@/i18n/navigation";
import { getSupabaseBrowserClient } from "@/lib/supabase/client";
import { aiDisclosureHref, parseLegalReadTarget } from "@/lib/legal/document-links";
import { getCurrentLegal, getLegalDocument } from "@/lib/legal/terms-acceptance";
import type { LegalDocument } from "@/lib/legal/legal-display";
import { LegalDocumentPage } from "./legal-document-page";
import { RestrictedLegalMarkdown } from "./restricted-legal-markdown";
type Props = {
  locale: "zh" | "en";
  kind: "terms" | "ai_terms";
};
function LegalStatus({
  locale,
  status
}: {
  locale: Props["locale"];
  status: "loading" | "unavailable" | "changed";
}) {
  const zh = locale === "zh";
  const text = status === "loading" ? zh ? "正在加载条款…" : "Loading terms…" : status === "changed" ? zh ? "此条款链接无法核实，请返回编辑器重新打开条款链接。" : "This terms link cannot be verified. Return to the editor and open the terms link again." : zh ? "当前条款暂不可用，请稍后刷新。" : "Current terms are unavailable. Please refresh later.";
  return <main className="h-dvh overflow-y-auto bg-bg p-8 text-foreground"><Link href="/" className="underline">{zh ? "返回编辑器" : "Back to editor"}</Link><p role={status === "changed" ? "alert" : "status"} className="mt-4">{text}</p></main>;
}
export function CurrentLegalDocument(props: Props) {
  return <Suspense fallback={<LegalStatus locale={props.locale} status="loading" />}><LegalReader {...props} /></Suspense>;
}
function LegalReader({
  locale,
  kind
}: Props) {
  const client = useMemo(() => getSupabaseBrowserClient(), []);
  const search = useSearchParams().toString();
  const target = useMemo(() => parseLegalReadTarget(kind, new URLSearchParams(search)), [kind, search]);
  const key = `${kind}:${search}`;
  const [outcome, setOutcome] = useState<{
    key: string;
    documents: LegalDocument[] | null;
  } | null>(null);
  useEffect(() => {
    let active = true;
    if (client && target.type !== "invalid") {
      const load = target.type === "terms" ? getLegalDocument(client, target.document).then(doc => [doc]) : target.type === "provider" ? Promise.all([getLegalDocument(client, target.common), getLegalDocument(client, target.provider)]) : getCurrentLegal(client).then(current => current.documents);
      void load.then(documents => {
        if (active) setOutcome({
          key,
          documents
        });
      }).catch(() => {
        if (active) setOutcome({
          key,
          documents: null
        });
      });
    }
    return () => {
      active = false;
    };
  }, [client, key, target]);
  if (target.type === "invalid") return <LegalStatus locale={locale} status="changed" />;
  const loaded = outcome?.key === key ? outcome : null;
  if (!client || loaded && !loaded.documents) return <LegalStatus locale={locale} status={target.type === "current" ? "unavailable" : "changed"} />;
  if (!loaded?.documents) return <LegalStatus locale={locale} status="loading" />;
  const documents = loaded.documents;
  const primary = documents.find(doc => doc.kind === (kind === "terms" ? "TERMS" : "AI_COMMON"));
  const providers = documents.filter(doc => doc.kind === "AI_PROVIDER");
  if (!primary || kind === "terms" && target.type === "terms" && documents.length !== 1 || target.type === "provider" && (documents.length !== 2 || providers.length !== 1)) return <LegalStatus locale={locale} status={target.type === "current" ? "unavailable" : "changed"} />;
  const title = locale === "zh" ? primary.zh_title : primary.en_title;
  return <LegalDocumentPage document={{
    title,
    effectiveDate: primary.effective_date,
    intro: [],
    sections: []
  }}>
    <RestrictedLegalMarkdown body={locale === "zh" ? primary.zh_body : primary.en_body} />
    {kind === "ai_terms" && (target.type === "provider" ? <section className="space-y-4 border-t border-border pt-8">
      <h2 className="text-xl font-semibold">{locale === "zh" ? providers[0].zh_title : providers[0].en_title}</h2>
      <p className="text-sm text-foreground-muted">{locale === "zh" ? "实际数据接收方：" : "Data recipient: "}{providers[0].recipient_name}</p>
      <p className="text-sm text-foreground-muted">{providers[0].effective_date}</p>
      <RestrictedLegalMarkdown body={locale === "zh" ? providers[0].zh_body : providers[0].en_body} />
    </section> : <section className="space-y-3"><h2 className="text-lg font-semibold">{locale === "zh" ? "各服务的数据处理说明" : "Service data-processing disclosures"}</h2><ul className="space-y-3">{providers.map(provider => <li key={provider.external_id}><Link className="font-medium text-accent-soft-foreground underline" href={aiDisclosureHref({
            common: primary,
            provider
          })}>{locale === "zh" ? provider.zh_title : provider.en_title}</Link></li>)}</ul></section>)}
  </LegalDocumentPage>;
}
