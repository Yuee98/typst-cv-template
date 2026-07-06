"use client";

import {
  Cloud,
  LogIn,
  LogOut,
  UserPlus,
  UserRound,
  UserRoundCheck,
} from "lucide-react";
import type { Session } from "@supabase/supabase-js";
import { useTranslations } from "next-intl";

import { ToolbarMenu } from "./toolbar-menu";
import { Button } from "@/components/ui/button";
import { MenuDivider, MenuItem } from "@/components/ui/menu-item";

export type CloudStatus = "idle" | "loading" | "ready" | "error";
export type TermsStatus = "unknown" | "accepted" | "required";

export function AccountMenu({
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
  const cloudLabel =
    termsStatus === "required"
      ? t("termsRequired")
      : cloudStatus === "loading"
        ? t("syncing")
        : cloudStatus === "error"
          ? t("cloudIssue")
          : t("cloudReady");

  return (
    <ToolbarMenu
      menuClassName="min-w-52 max-w-72"
      trigger={({ open, toggle }) => (
        <Button
          type="button"
          variant="secondary"
          size="icon"
          onClick={toggle}
          title={session ? t("signedInAccount") : t("account")}
          aria-label={session ? t("signedInAccount") : t("account")}
          aria-haspopup="menu"
          aria-expanded={open}
        >
          {session ? <UserRoundCheck /> : <UserRound />}
        </Button>
      )}
    >
      {({ close }) => (
        <>
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
                  close();
                  onSyncCloud();
                }}
              >
                {t("syncCloud")}
              </MenuItem>
              <MenuItem
                icon={<LogOut className="size-4" />}
                onClick={() => {
                  close();
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
                  close();
                  onOpenAuthModal("signIn");
                }}
              >
                {t("logIn")}
              </MenuItem>
              <MenuItem
                icon={<UserPlus className="size-4" />}
                disabled={!supabaseConfigured}
                onClick={() => {
                  close();
                  onOpenAuthModal("signUp");
                }}
              >
                {t("signUp")}
              </MenuItem>
            </>
          )}
        </>
      )}
    </ToolbarMenu>
  );
}
