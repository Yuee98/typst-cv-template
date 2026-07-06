"use client";

import { useTranslations } from "next-intl";

import { Button } from "@/components/ui/button";
import { GithubIcon } from "@/components/ui/github-icon";
import { Input } from "@/components/ui/input";
import { Modal } from "@/components/ui/modal";
import { Link } from "@/i18n/navigation";

export type AuthModalMode = "signIn" | "signUp";

export function AuthModal({
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
    <Modal
      title={mode === "signIn" ? t("title.signIn") : t("title.signUp")}
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
          <div className="rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-800">
            {error}
          </div>
        )}
        {successMessage && (
          <div className="rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800">
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
          <label className="flex items-start gap-2 rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-sm leading-5 text-slate-700">
            <input
              type="checkbox"
              className="mt-1 size-4 rounded border-slate-300"
              checked={termsAccepted}
              onChange={(event) => onTermsAcceptedChange(event.target.checked)}
            />
            <span>
              {t("terms.agreeTo")}{" "}
              <Link className="font-medium text-emerald-700 hover:text-emerald-600" href="/terms" target="_blank" rel="noreferrer">
                {t("terms.termsOfUse")}
              </Link>{" "}
              {t("terms.andAcknowledge")}{" "}
              <Link className="font-medium text-emerald-700 hover:text-emerald-600" href="/privacy" target="_blank" rel="noreferrer">
                {t("terms.privacyPolicy")}
              </Link>
              .
            </span>
          </label>
        )}
        <div className="flex items-center gap-3 text-xs uppercase tracking-wide text-slate-400">
          <div className="h-px flex-1 bg-slate-200" />
          <span>{t("divider")}</span>
          <div className="h-px flex-1 bg-slate-200" />
        </div>
        <Button type="button" variant="secondary" className="w-full" onClick={onGithubSignIn}>
          <GithubIcon className="!size-4" />
          {t("continueWithGithub")}
        </Button>
      </div>
    </Modal>
  );
}
