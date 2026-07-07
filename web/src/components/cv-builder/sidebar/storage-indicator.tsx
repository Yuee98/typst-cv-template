"use client";

import { Cloud, HardDrive, LockKeyhole } from "lucide-react";
import { useTranslations } from "next-intl";

import { cn } from "@/lib/utils";
import type { CvStorageKind } from "@/lib/cv/storage";

function StorageIcon({ storageKind }: { storageKind: CvStorageKind }) {
  if (storageKind === "encrypted") {
    return <LockKeyhole className="size-4" />;
  }

  if (storageKind === "cloud") {
    return <Cloud className="size-4" />;
  }

  return <HardDrive className="size-4" />;
}

export function storageLabel(storageKind: CvStorageKind) {
  if (storageKind === "encrypted") return "Encrypted";
  if (storageKind === "cloud") return "Cloud";
  return "Local";
}

export function StorageBadge({ storageKind }: { storageKind: CvStorageKind }) {
  const t = useTranslations("StorageIndicator");

  return (
    <span
      className={cn(
        "inline-flex h-6 shrink-0 items-center gap-1 rounded-md border px-1.5 text-[11px] font-medium",
        storageKind === "encrypted" && "border-violet-500/30 bg-violet-500/10 text-violet-600 dark:text-violet-400",
        storageKind === "cloud" && "border-sky-500/30 bg-sky-500/10 text-sky-600 dark:text-sky-400",
        storageKind === "local" && "border-border bg-surface-hover text-foreground-muted",
      )}
    >
      <StorageIcon storageKind={storageKind} />
      {t(storageKind)}
    </span>
  );
}

export function CompactStorageMark({ storageKind }: { storageKind: CvStorageKind }) {
  return (
    <span
      className={cn(
        "absolute -bottom-1 -right-1 flex size-4 items-center justify-center rounded-full border bg-surface",
        storageKind === "encrypted" && "border-violet-500/30 text-violet-600 dark:text-violet-400",
        storageKind === "cloud" && "border-sky-500/30 text-sky-600 dark:text-sky-400",
        storageKind === "local" && "border-border text-foreground-muted",
      )}
    >
      <StorageIcon storageKind={storageKind} />
    </span>
  );
}
