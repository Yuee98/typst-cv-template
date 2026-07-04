import type { Session, SupabaseClient } from "@supabase/supabase-js";
import type { UseFormReturn } from "react-hook-form";

import type { AuthModalMode } from "@/components/cv-builder/modals/auth-modal";
import {
  cloneCvData,
  errorMessage,
  summarizeLocalDocument,
  titleFromImportedData,
} from "@/lib/cv/cv-utils";
import { clearEncryptionPasswords } from "@/lib/cv/encryption-storage";
import { cvSchema, type CvData } from "@/lib/cv/schema";
import { sampleCvData } from "@/lib/cv/sample-data";
import {
  createLocalCvDocument,
  type CvDocumentSummary,
} from "@/lib/cv/storage";

type AuthActionsModal = {
  closeAfterAuth: () => void;
  email: string;
  mode: AuthModalMode | null;
  password: string;
  setError: (message: string | null) => void;
  setSuccessMessage: (message: string | null) => void;
  termsAccepted: boolean;
};

type AuthActionsTermsGate = {
  clearPendingAcceptance: () => void;
  markPendingAcceptance: () => void;
  recordAccepted: (client: SupabaseClient) => Promise<void>;
};

type SetOrderedDocuments = (
  documents: CvDocumentSummary[] | ((current: CvDocumentSummary[]) => CvDocumentSummary[]),
) => void;

export function useCvAuthActions({
  activeDocument,
  authModal,
  closeEncryptionModal,
  documents,
  form,
  loadDataIntoForm,
  session,
  setOrderedDocuments,
  supabase,
  termsGate,
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
  termsGate: AuthActionsTermsGate;
}) {
  async function signIn() {
    if (!supabase) {
      authModal.setError("Supabase is not configured. Add web/.env.local to enable cloud storage.");
      return;
    }

    if (!authModal.email || !authModal.password) {
      authModal.setError("Enter email and password before signing in.");
      return;
    }

    const { error: signInError } = await supabase.auth.signInWithPassword({
      email: authModal.email,
      password: authModal.password,
    });

    if (signInError) {
      authModal.setError(signInError.message);
    } else {
      authModal.closeAfterAuth();
    }
  }

  async function signUp() {
    if (!supabase) {
      authModal.setError("Supabase is not configured. Add web/.env.local to enable cloud storage.");
      return;
    }

    if (!authModal.email || !authModal.password) {
      authModal.setError("Enter email and password before creating an account.");
      return;
    }

    if (!authModal.termsAccepted) {
      authModal.setError("Agree to the Terms of Use and acknowledge the Privacy Policy before continuing.");
      return;
    }

    termsGate.markPendingAcceptance();

    const { data, error: signUpError } = await supabase.auth.signUp({
      email: authModal.email,
      password: authModal.password,
      options: {
        emailRedirectTo: window.location.origin,
      },
    });

    if (signUpError) {
      termsGate.clearPendingAcceptance();
      authModal.setError(signUpError.message);
      return;
    }

    if (!data.session) {
      authModal.setError(null);
      authModal.setSuccessMessage("Account created. Check your email before signing in.");
    } else {
      try {
        await termsGate.recordAccepted(supabase);
      } catch (termsError) {
        authModal.setError(errorMessage(termsError));
        return;
      }

      authModal.closeAfterAuth();
    }
  }

  async function signInWithGithub() {
    if (!supabase) {
      authModal.setError("Supabase is not configured. Add web/.env.local to enable cloud storage.");
      return;
    }

    if (authModal.mode === "signUp") {
      if (!authModal.termsAccepted) {
        authModal.setError("Agree to the Terms of Use and acknowledge the Privacy Policy before continuing.");
        return;
      }

      termsGate.markPendingAcceptance();
    }

    const { error: oauthError } = await supabase.auth.signInWithOAuth({
      provider: "github",
      options: {
        redirectTo: window.location.origin,
      },
    });

    if (oauthError) {
      if (authModal.mode === "signUp") {
        termsGate.clearPendingAcceptance();
      }
      authModal.setError(oauthError.message);
    }
  }

  async function signOut() {
    if (!supabase) {
      return;
    }

    const { error: signOutError } = await supabase.auth.signOut();
    if (signOutError) {
      authModal.setError(signOutError.message);
      return;
    }

    if (session?.user.id) {
      clearEncryptionPasswords(window.sessionStorage, session.user.id);
      clearEncryptionPasswords(window.localStorage, session.user.id);
    }
    closeEncryptionModal();

    const localDocuments = documents.filter((document) => document.storageKind === "local");
    const activeIsCloudBacked = activeDocument?.storageKind === "cloud" || activeDocument?.storageKind === "encrypted";
    if (activeIsCloudBacked || localDocuments.length === 0) {
      const parsed = cvSchema.safeParse(form.getValues());
      const fallbackData = parsed.success ? parsed.data : cloneCvData(sampleCvData);
      const fallbackTitle = activeDocument?.title ?? titleFromImportedData(fallbackData);
      const localDocument = createLocalCvDocument(fallbackData, fallbackTitle);
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
    signUp,
  };
}
