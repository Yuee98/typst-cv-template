import { useState } from "react";

import type { AuthModalMode } from "@/components/cv-builder/modals/auth-modal";

export function useAuthModal() {
  const [mode, setMode] = useState<AuthModalMode | null>(null);
  const [email, setEmailValue] = useState("");
  const [password, setPasswordValue] = useState("");
  const [termsAccepted, setTermsAcceptedValue] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);

  function openModal(nextMode: AuthModalMode) {
    setMode(nextMode);
    setTermsAcceptedValue(false);
    setError(null);
    setSuccessMessage(null);
  }

  function closeModal() {
    setMode(null);
    setTermsAcceptedValue(false);
    setError(null);
    setSuccessMessage(null);
  }

  function setEmail(value: string) {
    setEmailValue(value);
    setError(null);
    setSuccessMessage(null);
  }

  function setPassword(value: string) {
    setPasswordValue(value);
    setError(null);
    setSuccessMessage(null);
  }

  function setTermsAccepted(value: boolean) {
    setTermsAcceptedValue(value);
    setError(null);
  }

  function closeAfterAuth() {
    setMode(null);
    setPasswordValue("");
    setTermsAcceptedValue(false);
    setError(null);
    setSuccessMessage(null);
  }

  return {
    mode,
    email,
    password,
    termsAccepted,
    error,
    successMessage,
    openModal,
    closeModal,
    closeAfterAuth,
    setEmail,
    setPassword,
    setTermsAccepted,
    setError,
    setSuccessMessage,
  };
}
