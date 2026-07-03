"use client";

import { Cloud, LogIn, LogOut, UserPlus, UserRound } from "lucide-react";
import type { Session } from "@supabase/supabase-js";
import type { RefObject } from "react";

import { Toolbar, ToolbarGroup, ToolbarTitle } from "@/components/layout/toolbar";
import { Button } from "@/components/ui/button";
import { GithubIcon } from "@/components/ui/github-icon";

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
            <div className="absolute right-0 z-30 mt-2 w-64 rounded-md border border-slate-200 bg-white p-2 shadow-lg">
              {session ? (
                <div className="space-y-1">
                  <div className="border-b border-slate-200 px-2 pb-2">
                    <div className="truncate text-sm font-medium text-slate-950">{session.user.email}</div>
                    <div className="mt-1 flex items-center gap-1.5 text-xs text-slate-500">
                      <Cloud className="size-3.5" />
                      {cloudStatus === "loading" ? "Syncing" : "Cloud ready"}
                    </div>
                  </div>
                  <button
                    type="button"
                    className="flex h-9 w-full items-center gap-2 rounded px-2 text-left text-sm text-slate-700 hover:bg-slate-50"
                    onClick={onSyncCloud}
                  >
                    <Cloud className="size-4" />
                    Sync cloud
                  </button>
                  <button
                    type="button"
                    className="flex h-9 w-full items-center gap-2 rounded px-2 text-left text-sm text-slate-700 hover:bg-slate-50"
                    onClick={onSignOut}
                  >
                    <LogOut className="size-4" />
                    Log out
                  </button>
                </div>
              ) : (
                <div className="space-y-1">
                  <div className="border-b border-slate-200 px-2 pb-2 text-xs text-slate-500">
                    {supabaseConfigured ? "Cloud signed out" : "Cloud not configured"}
                  </div>
                  <button
                    type="button"
                    className="flex h-9 w-full items-center gap-2 rounded px-2 text-left text-sm text-slate-700 hover:bg-slate-50 disabled:opacity-50"
                    disabled={!supabaseConfigured}
                    onClick={() => onOpenAuthModal("signIn")}
                  >
                    <LogIn className="size-4" />
                    Log in
                  </button>
                  <button
                    type="button"
                    className="flex h-9 w-full items-center gap-2 rounded px-2 text-left text-sm text-slate-700 hover:bg-slate-50 disabled:opacity-50"
                    disabled={!supabaseConfigured}
                    onClick={() => onOpenAuthModal("signUp")}
                  >
                    <UserPlus className="size-4" />
                    Sign up
                  </button>
                  <button
                    type="button"
                    className="flex h-9 w-full items-center gap-2 rounded px-2 text-left text-sm text-slate-700 hover:bg-slate-50 disabled:opacity-50"
                    disabled={!supabaseConfigured}
                    onClick={onGithubSignIn}
                  >
                    <GithubIcon className="!size-4" />
                    GitHub SSO
                  </button>
                </div>
              )}
            </div>
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
