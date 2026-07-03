const ENCRYPTION_KEY_PREFIX = "typst-cv-builder:encryption:";
const TRUST_DEVICE_KEY_PREFIX = "typst-cv-builder:encryption-trust-device:";

function encryptionKey(userId: string, cvId: string) {
  return `${ENCRYPTION_KEY_PREFIX}${userId}:${cvId}`;
}

export function loadEncryptionPassword(userId: string, cvId: string) {
  if (typeof window === "undefined") {
    return null;
  }

  return (
    window.sessionStorage.getItem(encryptionKey(userId, cvId)) ??
    window.localStorage.getItem(encryptionKey(userId, cvId))
  );
}

export function storeEncryptionPassword(userId: string, cvId: string, passphrase: string, persist: boolean) {
  if (typeof window === "undefined") {
    return;
  }

  window.sessionStorage.setItem(encryptionKey(userId, cvId), passphrase);
  if (persist) {
    window.localStorage.setItem(encryptionKey(userId, cvId), passphrase);
  }
}

export function clearEncryptionPasswords(storage: Storage, userId: string) {
  const prefix = `${ENCRYPTION_KEY_PREFIX}${userId}:`;
  for (let index = storage.length - 1; index >= 0; index -= 1) {
    const key = storage.key(index);
    if (key?.startsWith(prefix)) {
      storage.removeItem(key);
    }
  }
}

function trustDeviceKey(userId: string) {
  return `${TRUST_DEVICE_KEY_PREFIX}${userId}`;
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
