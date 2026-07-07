import { useTranslations } from "next-intl";

import { Link } from "@/i18n/navigation";
import type { LegalDocument } from "@/content/legal";

export function LegalDocumentPage({ document }: { document: LegalDocument }) {
  const t = useTranslations("LegalDocumentPage");

  return (
    <main className="h-screen overflow-y-auto bg-bg px-4 py-8 text-foreground sm:px-6 lg:px-8">
      <article className="mx-auto max-w-3xl rounded-xl border border-border bg-surface px-5 py-6 shadow-sm sm:px-8 sm:py-8">
        <nav className="mb-8 flex flex-wrap items-center gap-3 text-sm text-foreground-muted">
          <Link className="font-medium text-accent-soft-foreground hover:text-accent" href="/">
            {t("brand")}
          </Link>
          <span>/</span>
          <span>{document.title}</span>
        </nav>

        <header className="border-b border-border pb-6">
          <h1 className="text-3xl font-semibold tracking-normal text-foreground">
            {document.title}
          </h1>
          <p className="mt-2 text-sm text-foreground-muted">
            {t("effectiveDate", { date: document.effectiveDate })}
          </p>
          <div className="mt-5 space-y-3 text-base leading-7 text-foreground-muted">
            {document.intro.map((paragraph) => (
              <p key={paragraph}>{paragraph}</p>
            ))}
          </div>
        </header>

        <div className="space-y-8 pt-8">
          {document.sections.map((section, index) => (
            <section key={section.heading} className="space-y-3">
              <h2 className="text-lg font-semibold text-foreground">
                {index + 1}. {section.heading}
              </h2>
              <div className="space-y-3 text-base leading-7 text-foreground-muted">
                {section.body.map((paragraph) => (
                  <p key={paragraph}>{paragraph}</p>
                ))}
                {section.bullets && (
                  <ul className="list-disc space-y-2 pl-6">
                    {section.bullets.map((item) => (
                      <li key={item}>{item}</li>
                    ))}
                  </ul>
                )}
              </div>
            </section>
          ))}
        </div>
      </article>
    </main>
  );
}