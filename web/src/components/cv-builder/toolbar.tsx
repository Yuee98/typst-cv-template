"use client";

import { Cloud, LogIn, LogOut, UserPlus, UserRound, UserRoundCheck } from "lucide-react";
import type { Session } from "@supabase/supabase-js";
import { useRef, useState } from "react";
import { useTranslations } from "next-intl";

import { LocaleSwitcher } from "@/components/layout/locale-switcher";
import { Toolbar, ToolbarGroup, ToolbarTitle } from "@/components/layout/toolbar";
import { Button } from "@/components/ui/button";
import { GithubIcon } from "@/components/ui/github-icon";
import { MenuContainer, MenuDivider, MenuItem } from "@/components/ui/menu-item";
import { useClickOutside } from "@/hooks/use-click-outside";

type CloudStatus = "idle" | "loading" | "ready" | "error";
type TermsStatus = "unknown" | "accepted" | "required";

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
  const t = useTranslations("CvToolbar");
  const [accountMenuOpen, setAccountMenuOpen] = useState(false);
  const accountMenuRef = useRef<HTMLDivElement>(null);
  useClickOutside(accountMenuRef, () => setAccountMenuOpen(false), accountMenuOpen);
  const cloudLabel =
    termsStatus === "required"
      ? t("termsRequired")
      : cloudStatus === "loading"
        ? t("syncing")
        : cloudStatus === "error"
          ? t("cloudIssue")
          : t("cloudReady");

  return (
    <Toolbar>
      <ToolbarTitle />
      <ToolbarGroup>
        <LocaleSwitcher />
        <Button variant="secondary" size="icon" asChild title="GitHub">
          <a
            href="https://github.com/Yuee98/typst-cv-template"
            target="_blank"
            rel="noopener noreferrer"
          >
            <GithubIcon className="!size-5" />
          </a>
        </Button>
        <div className="relative" ref={accountMenuRef}>
          <Button
            type="button"
            variant="secondary"
            size="icon"
            onClick={() => setAccountMenuOpen((open) => !open)}
            title={session ? t("signedInAccount") : t("account")}
            aria-label={session ? t("signedInAccount") : t("account")}
          >
            {session ? <UserRoundCheck /> : <UserRound />}
          </Button>
          {accountMenuOpen && (
            <MenuContainer>
              {session ? (
                <>
                  <MenuDivider>
                    <div className="truncate text-sm font-medium text-slate-950">{session.user.email}</div>
                    <div className="mt-1 flex items-center gap-1.5 text-xs text-slate-500">
                      <Cloud className="size-3.5" />
                      {cloudLabel}
                    </div>
                  </MenuDivider>
                  <MenuItem
                    icon={<Cloud className="size-4" />}
                    onClick={() => {
                      setAccountMenuOpen(false);
                      onSyncCloud();
                    }}
                  >
                    {t("syncCloud")}
                  </MenuItem>
                  <MenuItem
                    icon={<LogOut className="size-4" />}
                    onClick={() => {
                      setAccountMenuOpen(false);
                      onSignOut();
                    }}
                  >
                    {t("logOut")}
                  </MenuItem>
                </>
              ) : (
                <>
                  <MenuDivider>
                    <span className="text-xs text-slate-500">
                      {supabaseConfigured ? t("cloudSignedOut") : t("cloudNotConfigured")}
                    </span>
                  </MenuDivider>
                  <MenuItem
                    icon={<LogIn className="size-4" />}
                    disabled={!supabaseConfigured}
                    onClick={() => {
                      setAccountMenuOpen(false);
                      onOpenAuthModal("signIn");
                    }}
                  >
                    {t("logIn")}
                  </MenuItem>
                  <MenuItem
                    icon={<UserPlus className="size-4" />}
                    disabled={!supabaseConfigured}
                    onClick={() => {
                      setAccountMenuOpen(false);
                      onOpenAuthModal("signUp");
                    }}
                  >
                    {t("signUp")}
                  </MenuItem>
                </>
              )}
            </MenuContainer>
          )}
        </div>
      </ToolbarGroup>
    </Toolbar>
  );
}
