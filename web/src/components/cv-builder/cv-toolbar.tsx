"use client";

import type { Session } from "@supabase/supabase-js";

import {
  AccountMenu,
  GithubMenu,
  LocaleSwitcher,
  ThemeToggle,
  Toolbar,
  ToolbarGroup,
  ToolbarTitle,
  type CloudStatus,
  type TermsStatus,
} from "@/components/layout/toolbar";

export function CvToolbar({
  session,
  cloudStatus,
  termsStatus,
  supabaseConfigured,
  onOpenAuthModal,
  onSyncCloud,
  onSignOut,
}: {
  session: Session | null;
  cloudStatus: CloudStatus;
  termsStatus: TermsStatus;
  supabaseConfigured: boolean;
  onOpenAuthModal: (mode: "signIn" | "signUp") => void;
  onSyncCloud: () => void;
  onSignOut: () => void;
}) {
  return (
    <Toolbar>
      <ToolbarTitle />
      <ToolbarGroup>
        <ThemeToggle />
        <LocaleSwitcher />
        <GithubMenu />
        <AccountMenu
          session={session}
          cloudStatus={cloudStatus}
          termsStatus={termsStatus}
          supabaseConfigured={supabaseConfigured}
          onOpenAuthModal={onOpenAuthModal}
          onSyncCloud={onSyncCloud}
          onSignOut={onSignOut}
        />
      </ToolbarGroup>
    </Toolbar>
  );
}