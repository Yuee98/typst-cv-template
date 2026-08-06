import { describe, expect, it, vi } from "vitest";

import { handleCvStorageDeferredError } from "@/components/cv-builder/hooks/storage-deferred-error";
import {
  MissingPassphraseError,
  TermsNotAcceptedError,
} from "@/lib/cv/storage-adapters";

describe("handleCvStorageDeferredError", () => {
  it("consumes terms-deferred failures without opening a modal", () => {
    const openModal = vi.fn();

    expect(handleCvStorageDeferredError(new TermsNotAcceptedError("en"), "unlock", openModal)).toBe(true);
    expect(openModal).not.toHaveBeenCalled();
  });

  it.each(["unlock", "duplicate"] as const)("opens the existing %s modal for a missing passphrase", (mode) => {
    const openModal = vi.fn();
    const error = new MissingPassphraseError("doc-1", "en");

    expect(handleCvStorageDeferredError(error, mode, openModal)).toBe(true);
    expect(openModal).toHaveBeenCalledWith(mode, "doc-1");
  });

  it("does not consume unknown failures", () => {
    const openModal = vi.fn();

    expect(handleCvStorageDeferredError(new Error("unknown"), "unlock", openModal)).toBe(false);
    expect(openModal).not.toHaveBeenCalled();
  });
});
