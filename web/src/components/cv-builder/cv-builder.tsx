"use client";

import { Circle, FilePlus2, Loader2, Printer, RotateCcw, Save } from "lucide-react";
import { FormProvider } from "react-hook-form";

import { AppShell, Workspace } from "@/components/layout/app-shell";
import { Button } from "@/components/ui/button";
import { CvEditor } from "@/components/cv-builder/editors";
import { CvToolbar } from "@/components/cv-builder/toolbar";
import { AuthModal } from "@/components/cv-builder/modals/auth-modal";
import { EncryptionModal } from "@/components/cv-builder/modals/encryption-modal";
import { ImportExportErrorModal } from "@/components/cv-builder/modals/import-export-error-modal";
import { CvLibrarySidebar } from "@/components/cv-builder/sidebar/cv-library-sidebar";
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
              error={h.libraryError}
              onToggleCollapsed={h.toggleLibraryCollapsed}
              onCreateEmpty={() => void h.createEmptyDocument()}
              onCreateSample={() => void h.createSampleDocument()}
              onImportJson={() => h.importInputRef.current?.click()}
              onSelect={(id) => void h.selectDocument(id)}
              onRename={(id) => void h.renameDocument(id)}
              onDuplicate={(id) => void h.duplicateDocument(id)}
              onExport={(id) => void h.exportDocument(id)}
              onReorder={h.reorderDocuments}
              onDelete={(id) => void h.deleteDocument(id)}
              onMoveToCloud={(id) => void h.moveToCloud(id)}
              onEnableEncryption={(id) => {
                h.setEncryptionModal({ mode: "enable", documentId: id });
                h.setEncryptionPassword("");
                h.setEncryptionModalError(null);
              }}
              onDismissError={() => h.setLibraryError(null)}
            />
          }
          editor={
            h.activeDocumentId ? (
              <CvEditor
                actions={
                  h.activeDocument?.storageKind !== "local" && (
                    <div className="flex items-center gap-1">
                      {h.isDirty && (
                        <Button type="button" variant="ghost" size="icon" onClick={() => void h.discardChanges()} title="Discard changes">
                          <RotateCcw />
                        </Button>
                      )}
                      <div className="relative">
                        <Button type="button" variant="secondary" size="icon" disabled={h.saving} onClick={() => void h.saveCurrentDocument()} title="Save">
                          {h.saving ? <Loader2 className="animate-spin" /> : <Save />}
                        </Button>
                        {h.isDirty && (
                          <Circle className="absolute -right-0.5 -top-0.5 size-2.5 fill-amber-500 text-amber-500" />
                        )}
                      </div>
                    </div>
                  )
                }
              />
            ) : (
              <div className="flex h-full min-h-[720px] items-center justify-center rounded-lg border border-slate-200 bg-white">
                <div className="flex flex-col items-center gap-3 text-slate-400">
                  <FilePlus2 className="size-10" />
                  <p className="text-sm">Select or create a CV to start editing</p>
                </div>
              </div>
            )
          }
          preview={
            <PreviewPane
              svg={h.activeDocumentId ? h.svg : null}
              status={h.activeDocumentId ? h.status : "idle"}
              error={h.activeDocumentId ? h.previewError : null}
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
            error={h.authError}
            successMessage={h.successMessage}
            onEmailChange={(value) => {
              h.setAuthEmail(value);
              h.setAuthError(null);
              h.setSuccessMessage(null);
            }}
            onPasswordChange={(value) => {
              h.setAuthPassword(value);
              h.setAuthError(null);
              h.setSuccessMessage(null);
            }}
            onSignIn={() => void h.signIn()}
            onSignUp={() => void h.signUp()}
            onGithubSignIn={() => void h.signInWithGithub()}
            onClose={() => {
              h.setAuthModalMode(null);
              h.setAuthError(null);
              h.setSuccessMessage(null);
            }}
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
        {h.importExportError && (
          <ImportExportErrorModal
            error={h.importExportError}
            onClose={() => h.setImportExportError(null)}
          />
        )}
      </AppShell>
    </FormProvider>
  );
}
