"use client";

import { useTranslations } from "next-intl";

import { Button } from "@/components/ui/button";
import { GithubIcon } from "@/components/ui/github-icon";
import { Input } from "@/components/ui/input";
import { ModalDialog } from "@/components/ui/modal-dialog";
import { Link } from "@/i18n/navigation";

export type AuthModalMode = "signIn" | "signUp";

export function AuthModal({
  open,
  mode,
  email,
  password,
  error,
  successMessage,
  termsAccepted,
  onEmailChange,
  onPasswordChange,
  onTermsAcceptedChange,
  onSignIn,
  onSignUp,
  onGithubSignIn,
  onClose,
}: {
  open: boolean;
  mode: AuthModalMode;
  email: string;
  password: string;
  error: string | null;
  successMessage: string | null;
  termsAccepted: boolean;
  onEmailChange: (email: string) => void;
  onPasswordChange: (password: string) => void;
  onTermsAcceptedChange: (accepted: boolean) => void;
  onSignIn: () => void;
  onSignUp: () => void;
  onGithubSignIn: () => void;
  onClose: () => void;
}) {
  const t = useTranslations("AuthModal");

  return (
    <ModalDialog
      open={open}
      title={mode === "signIn" ? t("title.signIn") : t("title.signUp")}
      closeLabel={t("close")}
      onClose={onClose}
      footer={
        <>
          <Button type="button" variant="secondary" onClick={onClose}>
            {t("cancel")}
          </Button>
          <Button type="button" onClick={mode === "signIn" ? onSignIn : onSignUp}>
            {mode === "signIn" ? t("submit.signIn") : t("submit.signUp")}
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        {error && (
          <div className="rounded-md border border-danger-border bg-danger-soft px-3 py-2 text-sm text-danger-foreground">
            {error}
          </div>
        )}
        {successMessage && (
          <div className="rounded-md border border-success-border bg-success-soft px-3 py-2 text-sm text-success-foreground">
            {successMessage}
          </div>
        )}
        <Input
          type="email"
          value={email}
          onChange={(event) => onEmailChange(event.target.value)}
          placeholder={t("placeholder.email")}
        />
        <Input
          type="password"
          value={password}
          onChange={(event) => onPasswordChange(event.target.value)}
          placeholder={t("placeholder.password")}
        />
        {mode === "signUp" && (
          <label className="flex items-start gap-2 rounded-md border border-border bg-surface-hover px-3 py-2 text-sm leading-5 text-foreground-muted">
            <input
              type="checkbox"
              className="mt-1 size-4 rounded border-border-strong"
              checked={termsAccepted}
              onChange={(event) => onTermsAcceptedChange(event.target.checked)}
            />
            <span>
              {t("terms.agreeTo")}{" "}
              <Link className="font-medium text-accent-soft-foreground hover:text-accent" href="/terms" target="_blank" rel="noreferrer">
                {t("terms.termsOfUse")}
              </Link>{" "}
              {t("terms.andAcknowledge")}{" "}
              <Link className="font-medium text-accent-soft-foreground hover:text-accent" href="/privacy" target="_blank" rel="noreferrer">
                {t("terms.privacyPolicy")}
              </Link>
              .
            </span>
          </label>
        )}
        <div className="flex items-center gap-3 text-xs uppercase tracking-wide text-foreground-subtle">
          <div className="h-px flex-1 bg-border" />
          <span>{t("divider")}</span>
          <div className="h-px flex-1 bg-border" />
        </div>
        <Button type="button" variant="secondary" className="w-full" onClick={onGithubSignIn}>
          <GithubIcon className="!size-4" />
          {t("continueWithGithub")}
        </Button>
      </div>
    </ModalDialog>
  );
}
