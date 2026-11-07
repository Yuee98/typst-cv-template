"use client";

import { useEffect, useMemo, useState } from "react";
import { getSupabaseBrowserClient } from "@/lib/supabase/client";
import { getCurrentLegal, type CurrentLegal } from "@/lib/legal/terms-acceptance";
import { LegalDocumentPage } from "./legal-document-page";
export function CurrentLegalDocument({
  locale,
  kind
}: {
  locale: "zh" | "en";
  kind: "terms" | "ai_terms";
}) {
  const client = useMemo(() => getSupabaseBrowserClient(), []);
  const [current, setCurrent] = useState<CurrentLegal | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let active = true;
    if (client) void getCurrentLegal(client).then(value => {
      if (active) setCurrent(value);
    }).catch(() => {
      if (active) setFailed(true);
    });
    return () => {
      active = false;
    };
  }, [client]);
  const target = kind === "terms" ? current?.terms : current?.ai_bundle?.ai_terms;
  if (target) {
    const document = target.content[locale];
    const disclosures = kind === "ai_terms" ? current?.ai_bundle?.disclosures ?? [] : [];
    const sections = disclosures.map(disclosure => {
      const content = disclosure.content[locale];
      return {
        id: `provider-${disclosure.provider_code.toLowerCase()}`,
        heading: `${content.providerLabel} · ${content.modelLabel}`,
        body: content.blocks.flatMap(block => block.kind === "paragraph" ? [block.text] : []),
        bullets: content.blocks.flatMap(block => block.kind === "bulletList" ? block.items : [])
      };
    });
    return <LegalDocumentPage document={{
      ...document,
      sections: [...document.sections, ...sections]
    }} />;
  }
  return <main className="min-h-screen bg-background p-8 text-foreground"><a href={`/${locale}`} className="underline">{locale === "zh" ? "返回编辑器" : "Back to editor"}</a><p role="status" className="mt-4">{!client || failed || current ? locale === "zh" ? "当前条款暂不可用，请稍后刷新。" : "Current terms are unavailable. Please refresh later." : locale === "zh" ? "正在加载当前条款…" : "Loading current terms…"}</p></main>;
}
