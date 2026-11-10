import { cloudCacheScope } from "@/lib/supabase/app-context";
const ENCRYPTION_KEY_PREFIX = "typst-cv-builder:encryption:";
const TRUST_DEVICE_KEY_PREFIX = "typst-cv-builder:encryption-trust-device:";
const passwordOwners = new Map<string, object>();

// Obfuscation salt stored alongside the application code. This is not secret;
// it only ensures the derived key is domain-specific. The wrapping key is still
// derived from the user id, which is available in the client, so this layer
// cannot protect against an attacker who can execute code in the origin. It
// only prevents casual inspection of stored values (e.g. via DevTools).
const OBFUSCATION_SALT = new TextEncoder().encode("typst-cv-builder:v1");
const OBFUSCATION_ITERATIONS = 100_000;
function encryptionKey(userId: string, cvId: string) {
  return `${ENCRYPTION_KEY_PREFIX}${cloudCacheScope()}:${userId}:${cvId}`;
}
function passwordOwnerKey(userId: string) {
  return `${ENCRYPTION_KEY_PREFIX}${cloudCacheScope()}:${userId}:`;
}
export function captureEncryptionPasswordOwner(userId: string) {
  const key = passwordOwnerKey(userId);
  const owner = passwordOwners.get(key) ?? {};
  passwordOwners.set(key, owner);
  return () => passwordOwners.get(key) === owner;
}
export async function loadEncryptionPassword(userId: string, cvId: string) {
  if (typeof window === "undefined") {
    return null;
  }
  const raw = window.sessionStorage.getItem(encryptionKey(userId, cvId)) ?? window.localStorage.getItem(encryptionKey(userId, cvId));
  if (!raw) {
    return null;
  }
  const ownsPassword = captureEncryptionPasswordOwner(userId);
  const password = await decryptStoredPassword(userId, raw);
  return ownsPassword() ? password : null;
}
export async function storeEncryptionPassword(userId: string, cvId: string, passphrase: string, persist: boolean) {
  if (typeof window === "undefined") {
    return;
  }
  const key = encryptionKey(userId, cvId);
  const ownsPassword = captureEncryptionPasswordOwner(userId);
  const encrypted = await encryptStoredPassword(userId, passphrase);
  if (!ownsPassword()) return;
  window.sessionStorage.setItem(key, encrypted);
  if (persist) {
    window.localStorage.setItem(key, encrypted);
  }
}
export function clearEncryptionPasswords(storage: Storage, userId: string) {
  const prefix = passwordOwnerKey(userId);
  // Revoke pending crypto work before clearing the tab's stored envelopes.
  // A later sign-in by the same user receives a different owner token.
  passwordOwners.delete(prefix);
  for (let index = storage.length - 1; index >= 0; index -= 1) {
    const key = storage.key(index);
    if (key?.startsWith(prefix)) {
      storage.removeItem(key);
    }
  }
}
export function clearUserEncryptionPasswords(userId: string) {
  // Storage getters can throw before clearEncryptionPasswords is entered.
  // Revoke async work first, then try both stores without blocking Auth.
  passwordOwners.delete(passwordOwnerKey(userId));
  if (typeof window === "undefined") return;
  for (const name of ["sessionStorage", "localStorage"] as const) {
    try {
      clearEncryptionPasswords(window[name], userId);
    } catch {
      // Privacy restrictions can prevent deletion; they must not retain the
      // departed account in the UI or stop cleanup of the other storage.
    }
  }
}
function trustDeviceKey(userId: string) {
  return `${TRUST_DEVICE_KEY_PREFIX}${cloudCacheScope()}:${userId}`;
}
export function loadTrustDevice(userId: string) {
  if (typeof window === "undefined") {
    return false;
  }
  return window.localStorage.getItem(trustDeviceKey(userId)) === "true";
}
export function storeTrustDevice(userId: string, trust: boolean) {
  if (typeof window === "undefined") {
    return;
  }
  if (trust) {
    window.localStorage.setItem(trustDeviceKey(userId), "true");
  } else {
    window.localStorage.removeItem(trustDeviceKey(userId));
  }
}

// ── client-side obfuscation helpers ────────────────────────────────────────

async function deriveWrappingKey(userId: string): Promise<CryptoKey> {
  const keyMaterial = await crypto.subtle.importKey("raw", new TextEncoder().encode(userId), {
    name: "PBKDF2"
  }, false, ["deriveKey"]);
  return crypto.subtle.deriveKey({
    name: "PBKDF2",
    salt: OBFUSCATION_SALT,
    iterations: OBFUSCATION_ITERATIONS,
    hash: "SHA-256"
  }, keyMaterial, {
    name: "AES-GCM",
    length: 256
  }, false, ["encrypt", "decrypt"]);
}
async function encryptStoredPassword(userId: string, plaintext: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveWrappingKey(userId);
  const ciphertext = await crypto.subtle.encrypt({
    name: "AES-GCM",
    iv
  }, key, new TextEncoder().encode(plaintext));
  const combined = new Uint8Array(iv.length + ciphertext.byteLength);
  combined.set(iv);
  combined.set(new Uint8Array(ciphertext), iv.length);
  return btoa(String.fromCharCode(...combined));
}
async function decryptStoredPassword(userId: string, encoded: string): Promise<string | null> {
  try {
    const binary = atob(encoded);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    const iv = bytes.slice(0, 12);
    const ciphertext = bytes.slice(12);
    const key = await deriveWrappingKey(userId);
    const plaintext = await crypto.subtle.decrypt({
      name: "AES-GCM",
      iv
    }, key, ciphertext);
    return new TextDecoder().decode(plaintext);
  } catch {
    return null;
  }
}
