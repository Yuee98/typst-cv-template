"use client";

import { Printer, Save } from "lucide-react";
import { FormProvider } from "react-hook-form";

import { AppShell, Workspace } from "@/components/layout/app-shell";
import { Button } from "@/components/ui/button";
import { AuthModal } from "@/components/cv-builder/auth-modal";
import { CvEditor } from "@/components/cv-builder/editors";
import { EncryptionModal } from "@/components/cv-builder/encryption-modal";
import { CvLibrarySidebar } from "@/components/cv-builder/cv-library-sidebar";
import { CvToolbar } from "@/components/cv-builder/cv-toolbar";
import { PreviewPane } from "@/components/cv-builder/preview-pane";
import { useCvBuilder } from "@/components/cv-builder/hooks/use-cv-builder";

export function CvBuilder() {
  const h = useCvBuilder();

  return (
    <FormProvider {...h.form}>
      <AppShell>
        <CvToolbar
          session={h.session}
          cloudStatus={h.cloudStatus}
          accountMenuOpen={h.accountMenuOpen}
          supabaseConfigured={h.supabaseConfigured}
          importInputRef={h.importInputRef}
          onToggleAccountMenu={() => h.setAccountMenuOpen((open) => !open)}
          onOpenAuthModal={(mode) => {
            h.setAuthModalMode(mode);
            h.setAccountMenuOpen(false);
          }}
          onSyncCloud={() => void h.refreshCloudDocuments()}
          onSignOut={() => void h.signOut()}
          onGithubSignIn={() => void h.signInWithGithub()}
          onImportFile={(file) => void h.importJson(file)}
        />
        <Workspace
          library={
            <CvLibrarySidebar
              documents={h.documents}
              activeDocumentId={h.activeDocumentId}
              collapsed={h.libraryCollapsed}
              cloudActionsEnabled={h.cloudActionsEnabled}
              onToggleCollapsed={h.toggleLibraryCollapsed}
              onCreateEmpty={() => void h.createEmptyDocument()}
              onCreateSample={() => void h.createSampleDocument()}
              onImportJson={() => h.importInputRef.current?.click()}
              onSelect={(id) => void h.selectDocument(id)}
              onRename={(id) => void h.renameDocument(id)}
              onDuplicate={(id) => void h.duplicateDocument(id)}
              onExport={(id) => void h.exportDocument(id)}
              onDelete={(id) => void h.deleteDocument(id)}
              onMoveToCloud={(id) => void h.moveToCloud(id)}
              onEnableEncryption={(id) => {
                h.setEncryptionModal({ mode: "enable", documentId: id });
                h.setEncryptionPassword("");
                h.setEncryptionModalError(null);
              }}
            />
          }
          editor={
            <CvEditor
              actions={
                <Button type="button" variant="secondary" size="icon" onClick={() => void h.saveCurrentDocument()} title="Save">
                  <Save />
                </Button>
              }
            />
          }
          preview={
            <PreviewPane
              svg={h.svg}
              status={h.status}
              error={h.error}
              actions={
                <Button type="button" variant="secondary" size="icon" onClick={() => window.print()} title="Print">
                  <Printer />
                </Button>
              }
            />
          }
        />
        {h.authModalMode && (
          <AuthModal
            mode={h.authModalMode}
            email={h.authEmail}
            password={h.authPassword}
            onEmailChange={h.setAuthEmail}
            onPasswordChange={h.setAuthPassword}
            onSignIn={() => void h.signIn()}
            onSignUp={() => void h.signUp()}
            onGithubSignIn={() => void h.signInWithGithub()}
            onClose={() => h.setAuthModalMode(null)}
          />
        )}
        {h.encryptionModal && (
          <EncryptionModal
            mode={h.encryptionModal.mode}
            password={h.encryptionPassword}
            error={h.encryptionModalError}
            trustDevice={h.trustEncryptionDevice}
            onPasswordChange={(value) => {
              h.setEncryptionPassword(value);
              h.setEncryptionModalError(null);
            }}
            onTrustDeviceChange={h.setTrustEncryptionDevice}
            onSubmit={() => void h.submitEncryptionModal()}
            onClose={h.closeEncryptionModal}
          />
        )}
      </AppShell>
    </FormProvider>
  );
}
