"use client";

import { Cloud, LogIn, LogOut, UserPlus, UserRound } from "lucide-react";
import type { Session } from "@supabase/supabase-js";
import type { RefObject } from "react";

import { Toolbar, ToolbarGroup, ToolbarTitle } from "@/components/layout/toolbar";
import { Button } from "@/components/ui/button";
import { GithubIcon } from "@/components/ui/github-icon";
import { MenuContainer, MenuDivider, MenuItem } from "@/components/ui/menu-item";

type CloudStatus = "idle" | "loading" | "ready" | "error";

export function CvToolbar({
  session,
  cloudStatus,
  accountMenuOpen,
  supabaseConfigured,
  importInputRef,
  onToggleAccountMenu,
  onOpenAuthModal,
  onSyncCloud,
  onSignOut,
  onGithubSignIn,
  onImportFile,
}: {
  session: Session | null;
  cloudStatus: CloudStatus;
  accountMenuOpen: boolean;
  supabaseConfigured: boolean;
  importInputRef: RefObject<HTMLInputElement | null>;
  onToggleAccountMenu: () => void;
  onOpenAuthModal: (mode: "signIn" | "signUp") => void;
  onSyncCloud: () => void;
  onSignOut: () => void;
  onGithubSignIn: () => void;
  onImportFile: (file: File | undefined) => void;
}) {
  return (
    <Toolbar>
      <ToolbarTitle />
      <ToolbarGroup>
        <Button variant="secondary" size="icon" asChild title="GitHub">
          <a
            href="https://github.com/Yuee98/typst-cv-template"
            target="_blank"
            rel="noopener noreferrer"
          >
            <GithubIcon className="!size-5" />
          </a>
        </Button>
        <div className="relative">
          <Button
            type="button"
            variant={session ? "default" : "secondary"}
            size="icon"
            onClick={onToggleAccountMenu}
            title="Account"
          >
            <UserRound />
          </Button>
          {accountMenuOpen && (
            <MenuContainer>
              {session ? (
                <>
                  <MenuDivider>
                    <div className="truncate text-sm font-medium text-slate-950">{session.user.email}</div>
                    <div className="mt-1 flex items-center gap-1.5 text-xs text-slate-500">
                      <Cloud className="size-3.5" />
                      {cloudStatus === "loading" ? "Syncing" : "Cloud ready"}
                    </div>
                  </MenuDivider>
                  <MenuItem icon={<Cloud className="size-4" />} onClick={onSyncCloud}>
                    Sync cloud
                  </MenuItem>
                  <MenuItem icon={<LogOut className="size-4" />} onClick={onSignOut}>
                    Log out
                  </MenuItem>
                </>
              ) : (
                <>
                  <MenuDivider>
                    <span className="text-xs text-slate-500">
                      {supabaseConfigured ? "Cloud signed out" : "Cloud not configured"}
                    </span>
                  </MenuDivider>
                  <MenuItem
                    icon={<LogIn className="size-4" />}
                    disabled={!supabaseConfigured}
                    onClick={() => onOpenAuthModal("signIn")}
                  >
                    Log in
                  </MenuItem>
                  <MenuItem
                    icon={<UserPlus className="size-4" />}
                    disabled={!supabaseConfigured}
                    onClick={() => onOpenAuthModal("signUp")}
                  >
                    Sign up
                  </MenuItem>
                  <MenuItem
                    icon={<GithubIcon className="!size-4" />}
                    disabled={!supabaseConfigured}
                    onClick={onGithubSignIn}
                  >
                    GitHub SSO
                  </MenuItem>
                </>
              )}
            </MenuContainer>
          )}
        </div>
        <input
          ref={importInputRef}
          type="file"
          accept="application/json,.json"
          className="hidden"
          onChange={(event) => onImportFile(event.target.files?.[0])}
        />
      </ToolbarGroup>
    </Toolbar>
  );
}
