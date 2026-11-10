// @vitest-environment jsdom

import { webcrypto } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { clearEncryptionPasswords, loadEncryptionPassword, loadTrustDevice, storeEncryptionPassword, storeTrustDevice } from "@/lib/cv/encryption-storage";
const userId = "user-1";
const cvId = "cv-1";
const encryptionKey = "typst-cv-builder:encryption:uninitialized:user-1:cv-1";
beforeAll(() => {
  vi.stubGlobal("crypto", webcrypto);
});
afterAll(() => {
  vi.unstubAllGlobals();
});
beforeEach(() => {
  window.sessionStorage.clear();
  window.localStorage.clear();
});
afterEach(() => vi.restoreAllMocks());
describe("CV encryption browser storage", () => {
  it.each([false, true])("does not resurrect a cleared password when an earlier async store finishes (remember device: %s)", async persist => {
    const encrypt = webcrypto.subtle.encrypt.bind(webcrypto.subtle);
    let finishEncryption!: () => void;
    let enteredEncryption!: () => void;
    const entered = new Promise<void>(resolve => { enteredEncryption = resolve; });
    const paused = new Promise<void>(resolve => { finishEncryption = resolve; });
    vi.spyOn(webcrypto.subtle, "encrypt").mockImplementationOnce(async (...args) => {
      const ciphertext = await encrypt(...args);
      enteredEncryption();
      await paused;
      return ciphertext;
    });
    const pending = storeEncryptionPassword(userId, cvId, "obsolete-passphrase", persist);
    await entered;
    clearEncryptionPasswords(window.sessionStorage, userId);
    clearEncryptionPasswords(window.localStorage, userId);
    // A newly entered password in the next visit must survive the obsolete completion.
    await storeEncryptionPassword(userId, cvId, "new-visit-passphrase", persist);
    finishEncryption();
    await pending;
    await expect(loadEncryptionPassword(userId, cvId)).resolves.toBe("new-visit-passphrase");
    expect(window.localStorage.getItem(encryptionKey) !== null).toBe(persist);
  });
  it("does not return a cached password whose async unwrap completed after owner cleanup", async () => {
    await storeEncryptionPassword(userId, cvId, "obsolete-passphrase", true);
    const decrypt = webcrypto.subtle.decrypt.bind(webcrypto.subtle);
    let finishDecryption!: () => void;
    let enteredDecryption!: () => void;
    const entered = new Promise<void>(resolve => { enteredDecryption = resolve; });
    const paused = new Promise<void>(resolve => { finishDecryption = resolve; });
    vi.spyOn(webcrypto.subtle, "decrypt").mockImplementationOnce(async (...args) => {
      const plaintext = await decrypt(...args);
      enteredDecryption();
      await paused;
      return plaintext;
    });
    const pending = loadEncryptionPassword(userId, cvId);
    await entered;
    clearEncryptionPasswords(window.sessionStorage, userId);
    clearEncryptionPasswords(window.localStorage, userId);
    finishDecryption();
    await expect(pending).resolves.toBeNull();
  });
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
    window.sessionStorage.setItem("typst-cv-builder:encryption:uninitialized:user-2:cv-1", "other-user");
    window.localStorage.setItem(encryptionKey, "local-value");
    clearEncryptionPasswords(window.sessionStorage, userId);
    clearEncryptionPasswords(window.localStorage, userId);
    expect(window.sessionStorage.getItem(encryptionKey)).toBeNull();
    expect(window.localStorage.getItem(encryptionKey)).toBeNull();
    expect(window.sessionStorage.getItem("typst-cv-builder:encryption:uninitialized:user-2:cv-1")).toBe("other-user");
  });
  it("persists and clears the trusted-device flag", () => {
    expect(loadTrustDevice(userId)).toBe(false);
    storeTrustDevice(userId, true);
    expect(loadTrustDevice(userId)).toBe(true);
    storeTrustDevice(userId, false);
    expect(loadTrustDevice(userId)).toBe(false);
  });
});
