import type { Metadata } from "next";

import { LegalDocumentPage } from "@/components/legal/legal-document-page";
import { termsDocument } from "@/content/legal";

export const metadata: Metadata = {
  title: `${termsDocument.title} | cv maker`,
};

export default function TermsPage() {
  return <LegalDocumentPage document={termsDocument} />;
}
