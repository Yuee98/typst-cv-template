"use client";

import { CircleDot, ExternalLink } from "lucide-react";
import { useTranslations } from "next-intl";

import { ToolbarMenu } from "./toolbar-menu";
import { Button } from "@/components/ui/button";
import { GithubIcon } from "@/components/ui/github-icon";
import { MenuItem } from "@/components/ui/menu-item";

const GITHUB_REPOSITORY_URL = "https://github.com/Yuee98/typst-cv-template";
const GITHUB_ISSUES_URL = `${GITHUB_REPOSITORY_URL}/issues`;

export function GithubMenu() {
  const t = useTranslations("CvToolbar");

  return (
    <ToolbarMenu
      menuClassName="min-w-40"
      trigger={({ open, toggle }) => (
        <Button
          type="button"
          variant="secondary"
          size="icon"
          onClick={toggle}
          title={t("github")}
          aria-label={t("github")}
          aria-haspopup="menu"
          aria-expanded={open}
        >
          <GithubIcon className="!size-5" />
        </Button>
      )}
    >
      {({ close }) => (
        <>
          <MenuItem
            icon={<ExternalLink className="size-4" />}
            onClick={() => {
              close();
              window.open(GITHUB_REPOSITORY_URL, "_blank", "noopener,noreferrer");
            }}
          >
            {t("githubRepository")}
          </MenuItem>
          <MenuItem
            icon={<CircleDot className="size-4" />}
            onClick={() => {
              close();
              window.open(GITHUB_ISSUES_URL, "_blank", "noopener,noreferrer");
            }}
          >
            {t("githubIssues")}
          </MenuItem>
        </>
      )}
    </ToolbarMenu>
  );
}
