"use client";

import { Button } from "@/components/ui/button";
import { GithubIcon } from "@/components/ui/github-icon";
import { Input } from "@/components/ui/input";
import { Modal } from "@/components/ui/modal";

type AuthModalMode = "signIn" | "signUp";

export function AuthModal({
  mode,
  email,
  password,
  error,
  successMessage,
  onEmailChange,
  onPasswordChange,
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
  onEmailChange: (email: string) => void;
  onPasswordChange: (password: string) => void;
  onSignIn: () => void;
  onSignUp: () => void;
  onGithubSignIn: () => void;
  onClose: () => void;
}) {
  return (
    <Modal
      title={mode === "signIn" ? "Log in" : "Sign up"}
      onClose={onClose}
      footer={
        <>
          <Button type="button" variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="button" onClick={mode === "signIn" ? onSignIn : onSignUp}>
            {mode === "signIn" ? "Log in" : "Sign up"}
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
          placeholder="email"
        />
        <Input
          type="password"
          value={password}
          onChange={(event) => onPasswordChange(event.target.value)}
          placeholder="password"
        />
        <Button type="button" variant="secondary" className="w-full" onClick={onGithubSignIn}>
          <GithubIcon className="!size-4" />
          GitHub SSO
        </Button>
      </div>
    </Modal>
  );
}
