"use client";

import { useId } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { AdminMessages } from "./messages";
export function AdminAuthPanel({
  t,
  email,
  password,
  busy,
  error,
  onEmailChange,
  onPasswordChange,
  onSubmit,
  onGithubSignIn
}: {
  t: AdminMessages;
  email: string;
  password: string;
  busy: boolean;
  error?: string | null;
  onEmailChange: (email: string) => void;
  onPasswordChange: (password: string) => void;
  onSubmit: () => void;
  onGithubSignIn: () => void;
}) {
  const id = useId();
  return <section aria-labelledby={`${id}-title`} className="mx-auto w-full max-w-md space-y-6 rounded-2xl border border-border bg-surface px-6 py-8 shadow-sm sm:p-8">
    <header className="space-y-2">
      <h2 id={`${id}-title`} className="text-xl font-semibold">{t.loginTitle}</h2>
      <p className="text-sm leading-6 text-foreground-muted">{t.signInDescription}</p>
    </header>
    {error && <p role="alert" className="rounded-lg border border-danger-border bg-danger-soft px-3 py-2 text-sm text-danger-foreground">{error}</p>}
    <form aria-busy={busy} className="space-y-4" onSubmit={event => {
      event.preventDefault();
      if (!busy) onSubmit();
    }}>
      <div className="space-y-2">
        <label htmlFor={`${id}-email`} className="block text-sm font-medium">{t.email}</label>
        <Input id={`${id}-email`} name="email" type="email" autoComplete="username" inputMode="email" required disabled={busy} value={email} onChange={event => onEmailChange(event.target.value)} className="h-11 text-base" />
      </div>
      <div className="space-y-2">
        <label htmlFor={`${id}-password`} className="block text-sm font-medium">{t.password}</label>
        <Input id={`${id}-password`} name="password" type="password" autoComplete="current-password" required disabled={busy} value={password} onChange={event => onPasswordChange(event.target.value)} className="h-11 text-base" />
      </div>
      <Button type="submit" disabled={busy} className="h-11 w-full">{t.signIn}</Button>
    </form>
    <div className="border-t border-border pt-5">
      <Button type="button" variant="secondary" disabled={busy} className="h-11 w-full" onClick={onGithubSignIn}>{t.github}</Button>
    </div>
  </section>;
}
