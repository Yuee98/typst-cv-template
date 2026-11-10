import { webcrypto } from "node:crypto";
import { vi } from "vitest";
import { cloneCvData } from "@/lib/cv/cv-utils";
import { decryptCvData, encryptCvData } from "@/lib/cv/encryption";
import { loadEncryptionPassword, storeEncryptionPassword } from "@/lib/cv/encryption-storage";
import { sampleCvDataEn } from "@/lib/cv/sample-data";
import type { CvDocumentSummary } from "@/lib/cv/storage";
import type { LoadedCvDocument } from "@/lib/cv/storage-adapters";

/** Real cached-password unwrap and CV decryption, paused at the crypto await. */
export async function pauseEncryptedLoad(userId: string, summary: CvDocumentSummary) {
  vi.stubGlobal("crypto", webcrypto);
  const data = cloneCvData(sampleCvDataEn);
  data.header.subtitle = "synthetic-private-decryption-must-not-be-adopted";
  const password = "synthetic-cached-passphrase";
  const payload = await encryptCvData(data, password, "en");
  await storeEncryptionPassword(userId, summary.id, password, false);
  const decrypt = webcrypto.subtle.decrypt.bind(webcrypto.subtle);
  let enteredCrypto!: () => void;
  let finishCrypto!: () => void;
  const entered = new Promise<void>(resolve => { enteredCrypto = resolve; });
  const paused = new Promise<void>(resolve => { finishCrypto = resolve; });
  return {
    entered,
    finish: () => finishCrypto(),
    async load(): Promise<LoadedCvDocument> {
      const cachedPassword = await loadEncryptionPassword(userId, summary.id);
      if (!cachedPassword) throw new Error("Synthetic fixture must have a cached password");
      const spy = vi.spyOn(webcrypto.subtle, "decrypt").mockImplementationOnce(async (...args) => {
        const plaintext = await decrypt(...args);
        enteredCrypto();
        await paused;
        return plaintext;
      });
      try {
        return {
          data: await decryptCvData(payload, cachedPassword, "en"),
          summary: { ...summary, storageKind: "encrypted" },
          cloudRevision: "1",
        };
      } finally {
        spy.mockRestore();
      }
    },
  };
}
