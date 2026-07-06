import { useState } from "react";
import { useTranslations } from "next-intl";

import type { EncryptionModalMode } from "@/components/cv-builder/modals/encryption-modal";

// ── types ────────────────────────────────────────────────────────────────

interface EncryptionModalState {
  mode: EncryptionModalMode;
  documentId: string;
}

export interface EncryptionSubmitPayload {
  mode: EncryptionModalMode;
  documentId: string;
  password: string;
  trustDevice: boolean;
}

export type EncryptionSubmitResult = { error: string } | undefined | void;

export interface UseEncryptionModalReturn {
  modalState: EncryptionModalState | null;
  error: string | null;
  password: string;
  trustDevice: boolean;
  confirming: boolean;
  openModal: (mode: EncryptionModalMode, documentId: string) => void;
  closeModal: () => void;
  submit: (
    onSubmit: (payload: EncryptionSubmitPayload) => Promise<EncryptionSubmitResult>,
  ) => void;
  setPassword: (password: string) => void;
  setTrustDevice: (trust: boolean) => void;
  setError: (error: string | null) => void;
  setConfirming: (confirming: boolean) => void;
}

// ── hook ─────────────────────────────────────────────────────────────────

export function useEncryptionModal(
  tEncryption: ReturnType<typeof useTranslations<"EncryptionModal">>,
): UseEncryptionModalReturn {
  const [modalState, setModalState] = useState<EncryptionModalState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [password, setPassword] = useState("");
  const [trustDevice, setTrustDevice] = useState(() => false);
  const [confirming, setConfirming] = useState(false);

  function openModal(mode: EncryptionModalMode, documentId: string) {
    setModalState({ mode, documentId });
    setError(null);
    setPassword("");
    setConfirming(false);
  }

  function closeModal() {
    setModalState(null);
    setError(null);
    setPassword("");
    setConfirming(false);
  }

  function handleSetPassword(value: string) {
    setPassword(value);
    if (error) setError(null);
  }

  async function submit(
    onSubmit: (payload: EncryptionSubmitPayload) => Promise<EncryptionSubmitResult>,
  ) {
    if (!modalState) return;

    if (!password) {
      setError(tEncryption("error.passwordRequired"));
      return;
    }

    setError(null);
    const result = await onSubmit({
      mode: modalState.mode,
      documentId: modalState.documentId,
      password,
      trustDevice,
    });
    if (result?.error) {
      setError(result.error);
    }
  }

  return {
    modalState,
    error,
    password,
    trustDevice,
    confirming,
    openModal,
    closeModal,
    submit,
    setPassword: handleSetPassword,
    setTrustDevice,
    setError,
    setConfirming,
  };
}
