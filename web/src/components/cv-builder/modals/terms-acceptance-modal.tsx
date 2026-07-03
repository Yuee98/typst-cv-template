"use client";

import { Button } from "@/components/ui/button";
import { Modal } from "@/components/ui/modal";
import { TERMS_VERSION, termsAcceptanceSummary } from "@/content/legal";

export function TermsAcceptanceModal({
  checked,
  error,
  accepting,
  onCheckedChange,
  onAccept,
  onClose,
}: {
  checked: boolean;
  error: string | null;
  accepting: boolean;
  onCheckedChange: (checked: boolean) => void;
  onAccept: () => void;
  onClose: () => void;
}) {
  return (
    <Modal
      title="Terms and Privacy Notice"
      description="Accept the current terms before using cloud storage."
      onClose={onClose}
      footer={
        <>
          <Button type="button" variant="secondary" onClick={onClose} disabled={accepting}>
            Cancel
          </Button>
          <Button type="button" onClick={onAccept} disabled={!checked || accepting}>
            {accepting ? "Saving" : "Accept"}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {error && (
          <div className="rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-800">
            {error}
          </div>
        )}
        <div className="rounded-md border border-slate-200 bg-slate-50 px-3 py-3">
          <div className="text-xs font-medium uppercase tracking-wide text-slate-500">
            Version {TERMS_VERSION}
          </div>
          <ul className="mt-3 list-disc space-y-2 pl-5 text-sm leading-5 text-slate-700">
            {termsAcceptanceSummary.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </div>
        <label className="flex items-start gap-2 text-sm leading-5 text-slate-700">
          <input
            type="checkbox"
            className="mt-1 size-4 rounded border-slate-300"
            checked={checked}
            onChange={(event) => onCheckedChange(event.target.checked)}
          />
          <span>
            I agree to the{" "}
            <a className="font-medium text-emerald-700 hover:text-emerald-600" href="/terms" target="_blank" rel="noreferrer">
              Terms of Use
            </a>{" "}
            and acknowledge the{" "}
            <a className="font-medium text-emerald-700 hover:text-emerald-600" href="/privacy" target="_blank" rel="noreferrer">
              Privacy Policy
            </a>
            .
          </span>
        </label>
      </div>
    </Modal>
  );
}
