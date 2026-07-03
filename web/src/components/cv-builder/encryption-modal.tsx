"use client";

import { ShieldCheck } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Modal } from "@/components/ui/modal";

export type EncryptionModalMode = "enable" | "unlock" | "export" | "duplicate";

const modeTitles: Record<EncryptionModalMode, string> = {
  enable: "Enable encryption",
  unlock: "Unlock encrypted CV",
  duplicate: "Duplicate encrypted CV",
  export: "Export encrypted CV",
};

export function EncryptionModal({
  mode,
  password,
  error,
  trustDevice,
  onPasswordChange,
  onTrustDeviceChange,
  onSubmit,
  onClose,
}: {
  mode: EncryptionModalMode;
  password: string;
  error: string | null;
  trustDevice: boolean;
  onPasswordChange: (password: string) => void;
  onTrustDeviceChange: (trust: boolean) => void;
  onSubmit: () => void;
  onClose: () => void;
}) {
  return (
    <Modal
      title={modeTitles[mode]}
      onClose={onClose}
      footer={
        <>
          <Button type="button" variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="button" onClick={onSubmit}>
            <ShieldCheck />
            Continue
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <Input
          type="password"
          value={password}
          onChange={(event) => onPasswordChange(event.target.value)}
          placeholder="encryption password"
        />
        {error && (
          <p className="rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-700">
            {error}
          </p>
        )}
        <label className="flex items-center gap-1.5 text-xs text-slate-600">
          <input
            type="checkbox"
            checked={trustDevice}
            onChange={(event) => onTrustDeviceChange(event.target.checked)}
            className="size-3.5 accent-emerald-600"
          />
          Remember this device
        </label>
      </div>
    </Modal>
  );
}
