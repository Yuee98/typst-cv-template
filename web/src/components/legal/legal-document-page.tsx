import Link from "next/link";

import type { LegalDocument } from "@/content/legal";

export function LegalDocumentPage({ document }: { document: LegalDocument }) {
  return (
    <main className="min-h-screen bg-slate-50 px-4 py-8 text-slate-900 sm:px-6 lg:px-8">
      <article className="mx-auto max-w-3xl rounded-lg border border-slate-200 bg-white px-5 py-6 shadow-sm sm:px-8 sm:py-8">
        <nav className="mb-8 flex flex-wrap items-center gap-3 text-sm text-slate-500">
          <Link className="font-medium text-emerald-700 hover:text-emerald-600" href="/">
            cv maker
          </Link>
          <span>/</span>
          <span>{document.title}</span>
        </nav>

        <header className="border-b border-slate-200 pb-6">
          <h1 className="text-3xl font-semibold tracking-normal text-slate-950">
            {document.title}
          </h1>
          <p className="mt-2 text-sm text-slate-500">
            Effective Date: {document.effectiveDate}
          </p>
          <div className="mt-5 space-y-3 text-base leading-7 text-slate-700">
            {document.intro.map((paragraph) => (
              <p key={paragraph}>{paragraph}</p>
            ))}
          </div>
        </header>

        <div className="space-y-8 pt-8">
          {document.sections.map((section, index) => (
            <section key={section.heading} className="space-y-3">
              <h2 className="text-lg font-semibold text-slate-950">
                {index + 1}. {section.heading}
              </h2>
              <div className="space-y-3 text-base leading-7 text-slate-700">
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
