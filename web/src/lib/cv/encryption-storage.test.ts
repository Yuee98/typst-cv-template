// @vitest-environment jsdom

import { webcrypto } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import {
  clearEncryptionPasswords,
  loadEncryptionPassword,
  loadTrustDevice,
  storeEncryptionPassword,
  storeTrustDevice,
} from "@/lib/cv/encryption-storage";

const userId = "user-1";
const cvId = "cv-1";
const encryptionKey = "typst-cv-builder:encryption:user-1:cv-1";

beforeAll(() => {
  vi.stubGlobal("crypto", webcrypto);
});

afterAll(() => {
  vi.unstubAllGlobals();
});

describe("CV encryption browser storage", () => {
  it("stores an obfuscated password in session and trusted local storage", async () => {
    const passphrase = "test-passphrase";

    await storeEncryptionPassword(userId, cvId, passphrase, true);

    const sessionValue = window.sessionStorage.getItem(encryptionKey);
    const localValue = window.localStorage.getItem(encryptionKey);
    expect(sessionValue).not.toBeNull();
    expect(localValue).not.toBeNull();
    expect(sessionValue).not.toBe(passphrase);
    expect(localValue).not.toBe(passphrase);
    await expect(loadEncryptionPassword(userId, cvId)).resolves.toBe(passphrase);

    window.sessionStorage.removeItem(encryptionKey);
    await expect(loadEncryptionPassword(userId, cvId)).resolves.toBe(passphrase);
  });

  it("clears all passwords for a user and ignores malformed stored values", async () => {
    window.sessionStorage.setItem(encryptionKey, "not-an-envelope");
    expect(await loadEncryptionPassword(userId, cvId)).toBeNull();

    window.sessionStorage.setItem(encryptionKey, "session-value");
    window.sessionStorage.setItem("typst-cv-builder:encryption:user-2:cv-1", "other-user");
    window.localStorage.setItem(encryptionKey, "local-value");
    clearEncryptionPasswords(window.sessionStorage, userId);
    clearEncryptionPasswords(window.localStorage, userId);

    expect(window.sessionStorage.getItem(encryptionKey)).toBeNull();
    expect(window.localStorage.getItem(encryptionKey)).toBeNull();
    expect(window.sessionStorage.getItem("typst-cv-builder:encryption:user-2:cv-1")).toBe(
      "other-user",
    );
  });

  it("persists and clears the trusted-device flag", () => {
    expect(loadTrustDevice(userId)).toBe(false);

    storeTrustDevice(userId, true);
    expect(loadTrustDevice(userId)).toBe(true);

    storeTrustDevice(userId, false);
    expect(loadTrustDevice(userId)).toBe(false);
  });
});
