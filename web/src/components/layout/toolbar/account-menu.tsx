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

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

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
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="secondary"
          size="icon"
          title={session ? t("signedInAccount") : t("account")}
          aria-label={session ? t("signedInAccount") : t("account")}
        >
          {session ? <UserRoundCheck /> : <UserRound />}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-52 max-w-72">
        {session ? (
          <>
            <DropdownMenuLabel className="border-b border-slate-200 px-2 pb-2 pt-0">
              <div className="truncate text-sm font-medium text-slate-950">{session.user.email}</div>
              <div className="mt-1 flex items-center gap-1.5 text-xs font-normal text-slate-500">
                <Cloud className="size-3.5" />
                {cloudLabel}
              </div>
            </DropdownMenuLabel>
            <DropdownMenuItem icon={<Cloud className="size-4" />} onSelect={onSyncCloud}>
              {t("syncCloud")}
            </DropdownMenuItem>
            <DropdownMenuItem icon={<LogOut className="size-4" />} onSelect={onSignOut}>
              {t("logOut")}
            </DropdownMenuItem>
          </>
        ) : (
          <>
            <DropdownMenuLabel className="border-b border-slate-200 px-2 pb-2 pt-0">
              <span className="text-xs font-normal text-slate-500">
                {supabaseConfigured ? t("cloudSignedOut") : t("cloudNotConfigured")}
              </span>
            </DropdownMenuLabel>
            <DropdownMenuItem
              icon={<LogIn className="size-4" />}
              disabled={!supabaseConfigured}
              onSelect={() => onOpenAuthModal("signIn")}
            >
              {t("logIn")}
            </DropdownMenuItem>
            <DropdownMenuItem
              icon={<UserPlus className="size-4" />}
              disabled={!supabaseConfigured}
              onSelect={() => onOpenAuthModal("signUp")}
            >
              {t("signUp")}
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
