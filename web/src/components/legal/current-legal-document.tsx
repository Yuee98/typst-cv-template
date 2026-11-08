"use client";

import { Suspense, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import { Link } from "@/i18n/navigation";
import { getSupabaseBrowserClient } from "@/lib/supabase/client";
import { aiDisclosureHref, parseLegalReadTarget } from "@/lib/legal/document-links";
import { getCurrentLegal, type CurrentLegal } from "@/lib/legal/terms-acceptance";
import { LegalDocumentPage } from "./legal-document-page";

type Props = { locale: "zh" | "en"; kind: "terms" | "ai_terms" };

function LegalStatus({ locale, status }: { locale: Props["locale"]; status: "loading" | "unavailable" | "changed" }) {
  const zh = locale === "zh";
  const text = status === "loading"
    ? zh ? "正在加载条款…" : "Loading terms…"
    : status === "changed"
      ? zh ? "此链接对应的条款已更新或无法核实，请返回编辑器重新打开条款链接。" : "These terms have changed or the link cannot be verified. Return to the editor and open the terms link again."
      : zh ? "当前条款暂不可用，请稍后刷新。" : "Current terms are unavailable. Please refresh later.";
  return <main className="min-h-screen bg-background p-8 text-foreground">
    <Link href="/" className="underline">{zh ? "返回编辑器" : "Back to editor"}</Link>
    <p role={status === "changed" ? "alert" : "status"} className="mt-4">{text}</p>
  </main>;
}

export function CurrentLegalDocument(props: Props) {
  return <Suspense fallback={<LegalStatus locale={props.locale} status="loading" />}>
    <LegalReader {...props} />
  </Suspense>;
}

function LegalReader({ locale, kind }: Props) {
  const client = useMemo(() => getSupabaseBrowserClient(), []);
  const search = useSearchParams().toString();
  const target = useMemo(() => parseLegalReadTarget(kind, new URLSearchParams(search)), [kind, search]);
  const key = `${kind}:${search}`;
  const [outcome, setOutcome] = useState<{ key: string; current: CurrentLegal | null } | null>(null);
  useEffect(() => {
    let active = true;
    if (client && target.type !== "invalid") void getCurrentLegal(client).then(current => {
      if (active) setOutcome({ key, current });
    }).catch(() => {
      if (active) setOutcome({ key, current: null });
    });
    return () => { active = false; };
  }, [client, key, target.type]);

  if (target.type === "invalid") return <LegalStatus locale={locale} status="changed" />;
  const loaded = outcome?.key === key ? outcome : null;
  if (!client || loaded && !loaded.current) return <LegalStatus locale={locale} status="unavailable" />;
  if (!loaded?.current) return <LegalStatus locale={locale} status="loading" />;
  const current = loaded.current;

  if (kind === "terms") {
    if (target.type === "terms" && (current.terms.external_id !== target.documentId || current.terms.content_digest !== target.contentDigest)) {
      return <LegalStatus locale={locale} status="changed" />;
    }
    return <LegalDocumentPage document={current.terms.content[locale]} />;
  }

  const bundle = current.ai_bundle;
  if (!bundle) return <LegalStatus locale={locale} status={target.type === "current" ? "unavailable" : "changed"} />;
  if (target.type === "disclosure") {
    const disclosure = bundle.disclosures.find(item => item.external_id === target.disclosureId && item.content_digest === target.contentDigest);
    if (bundle.external_id !== target.bundleId || bundle.manifest_digest !== target.manifestDigest || !disclosure) {
      return <LegalStatus locale={locale} status="changed" />;
    }
    const content = disclosure.content[locale];
    return <LegalDocumentPage document={{
      title: `${bundle.ai_terms.content[locale].title} · ${content.providerLabel} · ${content.modelLabel}`,
      effectiveDate: bundle.ai_terms.content[locale].effectiveDate,
      intro: [],
      sections: [],
    }}>
      <section id={`provider-${disclosure.provider_code.toLowerCase()}`} className="space-y-4 text-base leading-7 text-foreground-muted">
        {content.blocks.map((block, index) => block.kind === "paragraph"
          ? <p className="whitespace-pre-wrap break-words" key={index}>{block.text}</p>
          : <ul key={index} className="list-disc space-y-2 pl-6">{block.items.map((item, i) => <li key={i}>{item}</li>)}</ul>)}
      </section>
    </LegalDocumentPage>;
  }

  // Each disclosure already contains the common terms. Link to complete
  // documents instead of embedding every Provider's copy in this directory.
  return <LegalDocumentPage document={bundle.ai_terms.content[locale]}>
    <section className="space-y-3">
      <h2 className="text-lg font-semibold text-foreground">{locale === "zh" ? "各 Provider 的数据处理说明" : "Provider data-processing disclosures"}</h2>
      <ul className="space-y-3">
        {bundle.disclosures.map(disclosure => {
          const content = disclosure.content[locale];
          return <li key={disclosure.external_id} id={`provider-${disclosure.provider_code.toLowerCase()}`} className="scroll-mt-6">
            <Link className="font-medium text-accent-soft-foreground underline underline-offset-2" href={aiDisclosureHref({
              bundleId: bundle.external_id,
              manifestDigest: bundle.manifest_digest,
              disclosureId: disclosure.external_id,
              contentDigest: disclosure.content_digest,
            })}>{content.providerLabel} · {content.modelLabel}</Link>
          </li>;
        })}
      </ul>
    </section>
  </LegalDocumentPage>;
}
