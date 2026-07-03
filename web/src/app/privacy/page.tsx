import type { Metadata } from "next";

import { LegalDocumentPage } from "@/components/legal/legal-document-page";
import { privacyDocument } from "@/content/legal";

export const metadata: Metadata = {
  title: `${privacyDocument.title} | cv maker`,
};

export default function PrivacyPage() {
  return <LegalDocumentPage document={privacyDocument} />;
}
