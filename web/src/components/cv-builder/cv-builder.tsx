"use client";

import { Circle, FilePlus2, Loader2, RotateCcw, Save } from "lucide-react";
import { FormProvider } from "react-hook-form";

import { AppShell, Workspace } from "@/components/layout/app-shell";
import { Button } from "@/components/ui/button";
import { CvEditor } from "@/components/cv-builder/editors";
import { ExportMenu } from "@/components/cv-builder/export-menu";
import { CvToolbar } from "@/components/cv-builder/toolbar";
import { AuthModal } from "@/components/cv-builder/modals/auth-modal";
import { EncryptionModal } from "@/components/cv-builder/modals/encryption-modal";
import { ImportExportErrorModal } from "@/components/cv-builder/modals/import-export-error-modal";
import { TermsAcceptanceModal } from "@/components/cv-builder/modals/terms-acceptance-modal";
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
          termsStatus={h.termsStatus}
          supabaseConfigured={h.supabaseConfigured}
          onOpenAuthModal={(mode) => {
            h.setAuthModalMode(mode);
            h.setSignupTermsAccepted(false);
            h.setAuthError(null);
            h.setSuccessMessage(null);
          }}
          onSyncCloud={() => void h.refreshCloudDocuments()}
          onSignOut={() => void h.signOut()}
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
              onImportFile={(file) => void h.importJson(file)}
              onSelect={(id) => void h.selectDocument(id)}
              onRename={(id) => void h.renameDocument(id)}
              onDuplicate={(id) => void h.duplicateDocument(id)}
              onReorder={h.reorderDocuments}
              onDelete={(id) => void h.deleteDocument(id)}
              onMoveToCloud={(id) => void h.moveToCloud(id)}
              onEnableEncryption={(id) => void h.openEnableEncryptionModal(id)}
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
              percent={h.activeDocumentId ? h.percent : null}
              error={h.activeDocumentId ? h.previewError : null}
              actions={
                <ExportMenu
                  disabled={!h.activeDocumentId}
                  exportingFormat={h.exportingFormat}
                  onDownloadPdf={() => void h.downloadPdf()}
                  onExportTypstPackage={() => void h.exportTypstPackage()}
                  onExportTypstSource={() => void h.exportTypstSource()}
                  onExportJson={() => void h.exportDocument()}
                />
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
            termsAccepted={h.signupTermsAccepted}
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
            onTermsAcceptedChange={(value) => {
              h.setSignupTermsAccepted(value);
              h.setAuthError(null);
            }}
            onSignIn={() => void h.signIn()}
            onSignUp={() => void h.signUp()}
            onGithubSignIn={() => void h.signInWithGithub()}
            onClose={() => {
              h.setAuthModalMode(null);
              h.setAuthError(null);
              h.setSuccessMessage(null);
              h.setSignupTermsAccepted(false);
            }}
          />
        )}
        {h.encryptionModal.modalState && (
          <EncryptionModal
            mode={h.encryptionModal.modalState.mode}
            password={h.encryptionModal.password}
            error={h.encryptionModal.error}
            trustDevice={h.encryptionModal.trustDevice}
            onPasswordChange={h.encryptionModal.setPassword}
            onTrustDeviceChange={h.encryptionModal.setTrustDevice}
            onSubmit={() => void h.encryptionModal.submit(h.handleEncryptionSubmit)}
            onClose={h.encryptionModal.closeModal}
          />
        )}
        {h.importExportError && (
          <ImportExportErrorModal
            error={h.importExportError}
            onClose={() => h.setImportExportError(null)}
          />
        )}
        {h.termsModalOpen && (
          <TermsAcceptanceModal
            checked={h.termsModalChecked}
            error={h.termsModalError}
            accepting={h.termsAccepting}
            onCheckedChange={(value) => {
              h.setTermsModalChecked(value);
              h.setTermsModalError(null);
            }}
            onAccept={() => void h.acceptTerms()}
            onClose={() => {
              h.setTermsModalOpen(false);
              h.setTermsModalChecked(false);
              h.setTermsModalError(null);
            }}
          />
        )}
      </AppShell>
    </FormProvider>
  );
}
