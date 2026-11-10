import type { Session, SupabaseClient } from "@supabase/supabase-js";
import type { UseFormReturn } from "react-hook-form";
import { useLocale, useTranslations } from "next-intl";
import type { AuthModalMode } from "@/components/cv-builder/modals/auth-modal";
import type { Locale } from "@/i18n/routing";
import { cloneCvData, createEmptyCvData, summarizeLocalDocument, titleFromImportedData } from "@/lib/cv/cv-utils";
import { clearEncryptionPasswords } from "@/lib/cv/encryption-storage";
import { cvSchema, type CvData } from "@/lib/cv/schema";
import { getSampleCvData } from "@/lib/cv/sample-data";
import { createLocalCvDocument, loadCvDocument, type CvDocumentSummary } from "@/lib/cv/storage";
type AuthActionsModal = {
  closeAfterAuth: () => void;
  email: string;
  mode: AuthModalMode | null;
  password: string;
  setError: (message: string | null) => void;
  setSuccessMessage: (message: string | null) => void;
  termsAccepted: boolean;
};
type SetOrderedDocuments = (documents: CvDocumentSummary[] | ((current: CvDocumentSummary[]) => CvDocumentSummary[])) => void;
function currentPageRedirectUrl() {
  return new URL(window.location.pathname, window.location.origin).toString();
}
export function useCvAuthActions({
  activeDocument,
  authModal,
  closeEncryptionModal,
  documents,
  form,
  loadDataIntoForm,
  session,
  setOrderedDocuments,
  supabase
}: {
  activeDocument: CvDocumentSummary | null;
  authModal: AuthActionsModal;
  closeEncryptionModal: () => void;
  documents: CvDocumentSummary[];
  form: UseFormReturn<CvData>;
  loadDataIntoForm: (id: string, data: CvData) => void;
  session: Session | null;
  setOrderedDocuments: SetOrderedDocuments;
  supabase: SupabaseClient | null;
}) {
  const locale = useLocale() as Locale;
  const t = useTranslations("CvAuthActions");
  const tImportExport = useTranslations("ImportExport");
  const tDocumentActions = useTranslations("CvDocumentActions");
  async function signIn() {
    if (!supabase) {
      authModal.setError(t("supabaseNotConfigured"));
      return;
    }
    if (!authModal.email || !authModal.password) {
      authModal.setError(t("signInMissingFields"));
      return;
    }
    const {
      error: signInError
    } = await supabase.auth.signInWithPassword({
      email: authModal.email,
      password: authModal.password
    });
    if (signInError) {
      authModal.setError(signInError.message);
    } else {
      authModal.closeAfterAuth();
    }
  }
  async function signUp() {
    if (!supabase) {
      authModal.setError(t("supabaseNotConfigured"));
      return;
    }
    if (!authModal.email || !authModal.password) {
      authModal.setError(t("signUpMissingFields"));
      return;
    }
    if (!authModal.termsAccepted) {
      authModal.setError(t("termsRequired"));
      return;
    }
    const {
      data,
      error: signUpError
    } = await supabase.auth.signUp({
      email: authModal.email,
      password: authModal.password,
      options: {
        emailRedirectTo: currentPageRedirectUrl()
      }
    });
    if (signUpError) {
      authModal.setError(signUpError.message);
      return;
    }
    if (!data.session) {
      authModal.setError(null);
      authModal.setSuccessMessage(t("accountCreated"));
    } else {
      authModal.closeAfterAuth();
    }
  }
  async function signInWithGithub() {
    if (!supabase) {
      authModal.setError(t("supabaseNotConfigured"));
      return;
    }
    if (authModal.mode === "signUp" && !authModal.termsAccepted) {
      authModal.setError(t("termsRequired"));
      return;
    }
    const {
      error: oauthError
    } = await supabase.auth.signInWithOAuth({
      provider: "github",
      options: {
        redirectTo: currentPageRedirectUrl()
      }
    });
    if (oauthError) {
      authModal.setError(oauthError.message);
    }
  }
  async function signOut() {
    if (!supabase) {
      return;
    }
    const localDocuments = documents.filter(document => document.storageKind === "local");
    let plaintextFallback: { data: CvData; title: string } | null = null;
    if (activeDocument?.storageKind !== "encrypted" && (activeDocument?.storageKind === "cloud" || localDocuments.length === 0)) {
      // Freeze this document's fallback before auth awaits can allow another form to be adopted.
      const parsed = cvSchema.safeParse(form.getValues());
      const data = parsed.success ? parsed.data : cloneCvData(getSampleCvData(locale));
      plaintextFallback = {
        data,
        title: activeDocument?.title ?? titleFromImportedData(data, tImportExport("importFallbackTitle"))
      };
    }
    const {
      error: signOutError
    } = await supabase.auth.signOut();
    if (signOutError) {
      authModal.setError(signOutError.message);
      return;
    }
    if (session?.user.id) {
      clearEncryptionPasswords(window.sessionStorage, session.user.id);
      clearEncryptionPasswords(window.localStorage, session.user.id);
    }
    closeEncryptionModal();
    if (activeDocument?.storageKind === "encrypted") {
      // Signing out must never turn decrypted content or its title into a plaintext local copy.
      const existingLocal = localDocuments.map(document => loadCvDocument(document.id)).find(document => document !== null);
      const fallback = existingLocal ?? createLocalCvDocument(createEmptyCvData(locale), tDocumentActions("emptyTitle"));
      setOrderedDocuments(existingLocal ? localDocuments : [summarizeLocalDocument(fallback), ...localDocuments]);
      loadDataIntoForm(fallback.id, fallback.data);
      return;
    }
    if (plaintextFallback) {
      const localDocument = createLocalCvDocument(plaintextFallback.data, plaintextFallback.title);
      setOrderedDocuments([summarizeLocalDocument(localDocument), ...localDocuments]);
      loadDataIntoForm(localDocument.id, localDocument.data);
    } else {
      setOrderedDocuments(localDocuments);
    }
  }
  return {
    signIn,
    signInWithGithub,
    signOut,
    signUp
  };
}
