import { webcrypto } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { sampleCvDataEn } from "@/lib/cv/sample-data";
import { decryptCvData, encryptCvData, type EncryptedPayload } from "@/lib/cv/encryption";

let payload: EncryptedPayload;

beforeAll(async () => {
  vi.stubGlobal("crypto", webcrypto);

  if (typeof globalThis.btoa !== "function") {
    vi.stubGlobal("btoa", (value: string) => Buffer.from(value, "binary").toString("base64"));
  }
  if (typeof globalThis.atob !== "function") {
    vi.stubGlobal("atob", (value: string) => Buffer.from(value, "base64").toString("binary"));
  }

  payload = await encryptCvData(sampleCvDataEn, "test-passphrase", "en");
});

afterAll(() => {
  vi.unstubAllGlobals();
});

describe("CV encryption", () => {
  it("round-trips current CV data through the Web Crypto envelope", async () => {
    expect(payload).toMatchObject({
      version: 1,
      algorithm: "AES-GCM",
      kdf: "PBKDF2-SHA-256",
      iterations: 600000,
    });
    expect(payload.salt).not.toHaveLength(0);
    expect(payload.iv).not.toHaveLength(0);
    expect(payload.ciphertext).not.toHaveLength(0);
    await expect(decryptCvData(payload, "test-passphrase", "en")).resolves.toEqual(sampleCvDataEn);
  });

  it("rejects an empty or incorrect passphrase without exposing the CV contents", async () => {
    await expect(encryptCvData(sampleCvDataEn, "", "en")).rejects.toThrow(
      "Encryption password is required",
    );
    await expect(decryptCvData(payload, "wrong-passphrase", "en")).rejects.toThrow(
      "Could not decrypt this CV",
    );
  });

  it("rejects malformed and unsupported envelopes before attempting decryption", async () => {
    const malformed = { version: 1, algorithm: "AES-GCM" };
    const unsupported = {
      version: 2,
      algorithm: "AES-GCM",
      kdf: "PBKDF2-SHA-256",
      iterations: 600000,
      salt: "AA==",
      iv: "AA==",
      ciphertext: "AA==",
    };

    await expect(decryptCvData(malformed, "test-passphrase", "en")).rejects.toThrow(
      "Encrypted CV payload is not supported",
    );
    await expect(decryptCvData(unsupported, "test-passphrase", "en")).rejects.toThrow(
      "Encrypted CV payload is not supported",
    );
  });

  it("rejects decrypted JSON that does not satisfy the persisted CV schema", async () => {
    const decryptSpy = vi.spyOn(crypto.subtle, "decrypt").mockResolvedValue(
      new TextEncoder().encode("{}").buffer,
    );

    try {
      await expect(decryptCvData(payload, "test-passphrase", "en")).rejects.toThrow(
        "does not match the current CV schema",
      );
    } finally {
      decryptSpy.mockRestore();
    }
  });
});
