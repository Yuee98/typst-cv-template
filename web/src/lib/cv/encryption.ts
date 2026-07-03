import { z } from "zod";

import { cvSchema, type CvData } from "./schema";

const encryptedPayloadSchema = z.object({
  version: z.literal(1),
  algorithm: z.literal("AES-GCM"),
  kdf: z.literal("PBKDF2-SHA-256"),
  iterations: z.number().int().positive(),
  salt: z.string(),
  iv: z.string(),
  ciphertext: z.string(),
});

export type EncryptedPayload = z.infer<typeof encryptedPayloadSchema>;

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const encryptionIterations = 600000;

function requireSubtleCrypto() {
  if (typeof crypto === "undefined" || !crypto.subtle) {
    throw new Error("This browser does not support Web Crypto encryption.");
  }

  return crypto.subtle;
}

function bytesToBase64(bytes: Uint8Array) {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }

  return btoa(binary);
}

function base64ToBytes(value: string) {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);

  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }

  return bytes;
}

function toArrayBuffer(bytes: Uint8Array) {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

async function deriveAesKey(passphrase: string, salt: Uint8Array, usages: KeyUsage[]) {
  const subtle = requireSubtleCrypto();
  const keyMaterial = await subtle.importKey("raw", encoder.encode(passphrase), "PBKDF2", false, [
    "deriveKey",
  ]);

  return subtle.deriveKey(
    {
      name: "PBKDF2",
      salt: toArrayBuffer(salt),
      iterations: encryptionIterations,
      hash: "SHA-256",
    },
    keyMaterial,
    { name: "AES-GCM", length: 256 },
    false,
    usages,
  );
}

export async function encryptCvData(data: CvData, passphrase: string): Promise<EncryptedPayload> {
  if (!passphrase) {
    throw new Error("Encryption password is required.");
  }

  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveAesKey(passphrase, salt, ["encrypt"]);
  const plaintext = encoder.encode(JSON.stringify(data));
  const ciphertext = new Uint8Array(
    await requireSubtleCrypto().encrypt(
      { name: "AES-GCM", iv: toArrayBuffer(iv) },
      key,
      toArrayBuffer(plaintext),
    ),
  );

  return {
    version: 1,
    algorithm: "AES-GCM",
    kdf: "PBKDF2-SHA-256",
    iterations: encryptionIterations,
    salt: bytesToBase64(salt),
    iv: bytesToBase64(iv),
    ciphertext: bytesToBase64(ciphertext),
  };
}

export async function decryptCvData(payload: unknown, passphrase: string): Promise<CvData> {
  if (!passphrase) {
    throw new Error("Encryption password is required.");
  }

  const parsedPayload = encryptedPayloadSchema.safeParse(payload);
  if (!parsedPayload.success) {
    throw new Error("Encrypted CV payload is not supported.");
  }

  const salt = base64ToBytes(parsedPayload.data.salt);
  const iv = base64ToBytes(parsedPayload.data.iv);
  const ciphertext = base64ToBytes(parsedPayload.data.ciphertext);
  const key = await deriveAesKey(passphrase, salt, ["decrypt"]);

  try {
    const plaintext = await requireSubtleCrypto().decrypt(
      { name: "AES-GCM", iv: toArrayBuffer(iv) },
      key,
      toArrayBuffer(ciphertext),
    );
    const parsedData = cvSchema.safeParse(JSON.parse(decoder.decode(plaintext)));

    if (!parsedData.success) {
      throw new Error("Decrypted CV data does not match the current CV schema.");
    }

    return parsedData.data;
  } catch (decryptError) {
    if (decryptError instanceof Error && decryptError.message.includes("schema")) {
      throw decryptError;
    }

    throw new Error("Could not decrypt this CV with the provided password.");
  }
}
