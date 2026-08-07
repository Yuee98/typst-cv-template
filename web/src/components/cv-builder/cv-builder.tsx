"use client";

import { Circle, FilePlus2, FileText, Loader2, RotateCcw, Save } from "lucide-react";
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useMemo, useRef } from "react";
import { FormProvider, useWatch } from "react-hook-form";

import { AppShell, Workspace } from "@/components/layout/app-shell";
import { Button } from "@/components/ui/button";
import { CvEditor } from "@/components/cv-builder/editors";
import { ExportMenu } from "@/components/cv-builder/export-menu";
import { CvToolbar } from "@/components/cv-builder/cv-toolbar";
import { AuthModal } from "@/components/cv-builder/modals/auth-modal";
import { EncryptionModal } from "@/components/cv-builder/modals/encryption-modal";
import { ImportExportErrorModal } from "@/components/cv-builder/modals/import-export-error-modal";
import { TermsAcceptanceModal } from "@/components/cv-builder/modals/terms-acceptance-modal";
import { DocumentActionDialogs } from "@/components/cv-builder/document-action-dialogs";
import { CvLibrarySidebar } from "@/components/cv-builder/sidebar/cv-library-sidebar";
import { PreviewPane } from "@/components/cv-builder/preview-pane";
import { useCvBuilder } from "@/components/cv-builder/hooks/use-cv-builder";
import { PolishDialog } from "@/components/cv-builder/polish/polish-dialog";
import { isAiPolishUiEnabled } from "@/components/cv-builder/polish/polish-entry";
import { PolishEntryProvider } from "@/components/cv-builder/polish/polish-entry-context";
import {
  savePendingPolishIntent,
  takePendingPolishIntent,
} from "@/components/cv-builder/polish/polish-intent";
import type { PolishScope } from "@/components/cv-builder/polish/scope-builder";
import { usePolishFlow } from "@/components/cv-builder/polish/use-polish-flow";

export function CvBuilder() {
  const t = useTranslations("CvBuilder");
  const deleteRestoreFocusRef = useRef<HTMLElement | null>(null);
  const h = useCvBuilder();

  // ── AI polish wiring (unit 3.5: the only integration point) ────────
  // The entries render only when NEXT_PUBLIC_AI_POLISH_ENABLED === "true"
  // (never in the static export); the dialog stays mounted-but-closed so
  // the flow hook identity is stable.
  const polishUiEnabled = isAiPolishUiEnabled();
  const typstLang = useWatch({ control: h.form.control, name: "typstLang" }) ?? "en";
  const session = h.session;
  const polishFlow = usePolishFlow({
    form: h.form,
    documentId: h.activeDocumentId,
    encrypted: h.activeDocument?.storageKind === "encrypted",
    language: typstLang,
    session,
    supabase: h.supabase,
  });
  const { open: openPolishFlow } = polishFlow;

  // Entry click: signed in → open the dialog with the declared scope;
  // signed out → stash the intent and guide through the existing auth modal.
  const requestPolish = useCallback(
    (scope: PolishScope) => {
      if (session) {
        openPolishFlow(scope);
        return;
      }
      if (h.activeDocumentId) {
        savePendingPolishIntent({
          documentId: h.activeDocumentId,
          scope,
          createdAt: Date.now(),
        });
      }
      h.authModal.openModal("signIn");
    },
    [session, h.activeDocumentId, h.authModal, openPolishFlow],
  );

  // Restore the stashed intent once a session appears (form sign-in or an
  // OAuth round-trip): the dialog re-opens with the originally clicked scope.
  useEffect(() => {
    if (!polishUiEnabled || !session || !h.activeDocumentId) return;
    const scope = takePendingPolishIntent(h.activeDocumentId);
    if (scope) openPolishFlow(scope);
  }, [polishUiEnabled, session, h.activeDocumentId, openPolishFlow]);

  const polishEntryValue = useMemo(() => ({ requestPolish }), [requestPolish]);

  return (
    <FormProvider {...h.form}>
      <PolishEntryProvider value={polishEntryValue}>
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
              onRename={(id) => void h.openRenameDialog(id)}
              onDuplicate={(id) => void h.openDuplicateDialog(id)}
              onReorder={h.reorderDocuments}
              onDelete={(id) => void h.openDeleteDialog(id)}
              onMoveToCloud={(id) => void h.moveToCloud(id)}
              onEnableEncryption={(id) => void h.openEnableEncryptionModal(id)}
              onDismissError={() => h.setLibraryError(null)}
              restoreFocusRef={deleteRestoreFocusRef}
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
                          <Circle className="absolute -right-0.5 -top-0.5 size-2.5 fill-warning text-warning" />
                        )}
                      </div>
                    </div>
                  )
                }
              />
            ) : (
              <div className="flex h-full min-h-0 items-center justify-center overflow-hidden rounded-xl border border-border glass-panel shadow-sm">
                <div className="flex max-w-sm flex-col items-center gap-4 px-6 text-center">
                  <FilePlus2 className="size-10 text-foreground-subtle" />
                  <p className="text-sm text-foreground-muted">{t("emptyState")}</p>
                  <div className="flex flex-wrap justify-center gap-2">
                    <Button type="button" onClick={() => void h.createEmptyDocument()}>
                      <FilePlus2 />
                      {t("createEmpty")}
                    </Button>
                    <Button
                      type="button"
                      variant="secondary"
                      onClick={() => void h.createSampleDocument()}
                    >
                      <FileText />
                      {t("createSample")}
                    </Button>
                  </div>
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
        <DocumentActionDialogs
          renameDialog={h.renameDialog}
          duplicateDialog={h.duplicateDialog}
          deleteDialog={h.deleteDialog}
          onCloseRenameDialog={h.closeRenameDialog}
          onSubmitRenameDialog={(nextTitle) => void h.submitRenameDialog(nextTitle)}
          onCloseDuplicateDialog={h.closeDuplicateDialog}
          onSubmitDuplicateDialog={(nextTitle) => void h.submitDuplicateDialog(nextTitle)}
          onCloseDeleteDialog={h.closeDeleteDialog}
          onConfirmDeleteDialog={() => void h.confirmDeleteDialog()}
          deleteRestoreFocusRef={deleteRestoreFocusRef}
        />
        </AppShell>
      </PolishEntryProvider>
      {polishUiEnabled && <PolishDialog flow={polishFlow} language={typstLang} />}
    </FormProvider>
  );
}
