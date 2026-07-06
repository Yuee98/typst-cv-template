"use client";

import { Circle, FilePlus2, Loader2, RotateCcw, Save } from "lucide-react";
import { useTranslations } from "next-intl";
import { FormProvider } from "react-hook-form";

import { AppShell, Workspace } from "@/components/layout/app-shell";
import { Button } from "@/components/ui/button";
import { CvEditor } from "@/components/cv-builder/editors";
import { ExportMenu } from "@/components/cv-builder/export-menu";
import { CvToolbar } from "@/components/cv-builder/cv-toolbar";
import { AuthModal } from "@/components/cv-builder/modals/auth-modal";
import { EncryptionModal } from "@/components/cv-builder/modals/encryption-modal";
import { ImportExportErrorModal } from "@/components/cv-builder/modals/import-export-error-modal";
import { TermsAcceptanceModal } from "@/components/cv-builder/modals/terms-acceptance-modal";
import { CvLibrarySidebar } from "@/components/cv-builder/sidebar/cv-library-sidebar";
import { PreviewPane } from "@/components/cv-builder/preview-pane";
import { useCvBuilder } from "@/components/cv-builder/hooks/use-cv-builder";

export function CvBuilder() {
  const t = useTranslations("CvBuilder");
  const h = useCvBuilder();

  return (
    <FormProvider {...h.form}>
      <AppShell>
        <CvToolbar
          session={h.session}
          cloudStatus={h.cloudStatus}
          termsStatus={h.termsGate.status}
          supabaseConfigured={h.supabaseConfigured}
          onOpenAuthModal={h.authModal.openModal}
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
                        <Button type="button" variant="ghost" size="icon" onClick={() => void h.discardChanges()} title={t("discardChanges")}>
                          <RotateCcw />
                        </Button>
                      )}
                      <div className="relative">
                        <Button type="button" variant="secondary" size="icon" disabled={h.saving} onClick={() => void h.saveCurrentDocument()} title={t("save")}>
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
                  <p className="text-sm">{t("emptyState")}</p>
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
        <AuthModal
          open={!!h.authModal.mode}
          mode={h.authModal.mode ?? "signIn"}
          email={h.authModal.email}
          password={h.authModal.password}
          error={h.authModal.error}
          successMessage={h.authModal.successMessage}
          termsAccepted={h.authModal.termsAccepted}
          onEmailChange={h.authModal.setEmail}
          onPasswordChange={h.authModal.setPassword}
          onTermsAcceptedChange={h.authModal.setTermsAccepted}
          onSignIn={() => void h.signIn()}
          onSignUp={() => void h.signUp()}
          onGithubSignIn={() => void h.signInWithGithub()}
          onClose={h.authModal.closeModal}
        />
        <EncryptionModal
          open={!!h.encryptionModal.modalState}
          mode={h.encryptionModal.modalState?.mode ?? "unlock"}
          password={h.encryptionModal.password}
          error={h.encryptionModal.error}
          trustDevice={h.encryptionModal.trustDevice}
          confirming={h.encryptionModal.confirming}
          onPasswordChange={h.encryptionModal.setPassword}
          onTrustDeviceChange={h.encryptionModal.setTrustDevice}
          onSetError={h.encryptionModal.setError}
          onSetConfirming={h.encryptionModal.setConfirming}
          onSubmit={() => void h.encryptionModal.submit(h.handleEncryptionSubmit)}
          onClose={h.encryptionModal.closeModal}
        />
        <ImportExportErrorModal
          open={!!h.importExportError}
          error={h.importExportError ?? ""}
          onClose={() => h.setImportExportError(null)}
        />
        <TermsAcceptanceModal
          open={h.termsGate.modalOpen}
          checked={h.termsGate.modalChecked}
          error={h.termsGate.modalError}
          accepting={h.termsGate.accepting}
          onCheckedChange={(value) => {
            h.termsGate.setModalChecked(value);
            h.termsGate.setModalError(null);
          }}
          onAccept={() => void h.acceptTerms()}
          onClose={() => {
            h.termsGate.setModalOpen(false);
            h.termsGate.setModalChecked(false);
            h.termsGate.setModalError(null);
          }}
        />
      </AppShell>
    </FormProvider>
  );
}
