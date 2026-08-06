import type { EncryptionModalMode } from "@/components/cv-builder/modals/encryption-modal";
import {
  isMissingPassphraseError,
  isTermsNotAcceptedError,
} from "@/lib/cv/storage-adapters";

/**
 * Classify storage failures at the builder boundary without coupling storage
 * adapters to modal state. Terms failures are consumed by the cloud gate;
 * missing passphrases open the existing mode-specific encryption modal.
 */
export function handleCvStorageDeferredError(
  error: unknown,
  mode: EncryptionModalMode,
  openModal: (mode: EncryptionModalMode, documentId: string) => void,
) {
  if (isTermsNotAcceptedError(error)) {
    return true;
  }

  if (isMissingPassphraseError(error)) {
    openModal(mode, error.documentId);
    return true;
  }

  return false;
}
