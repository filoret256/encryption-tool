/**
 * Helm-tab encryptor (TypeScript).
 *
 * NOTE: "Helm" here is an internal convention, NOT a real Helm format
 * (`helm secrets` delegates to SOPS/age/Vault). This is the redesigned
 * scheme adopted during the Bun migration — PBKDF2 key derivation replaces
 * the legacy zero-pad-to-32 password key, which removes the latent bug where
 * a password > 32 bytes broke AES-256. No backward-compat with legacy
 * ciphertext is required (decision 2026-06-05).
 *
 *   Key derivation: PBKDF2-HMAC-SHA256, 10000 iterations, dklen 32
 *   Encryption    : AES-256-CBC + PKCS#7 padding
 *   Wire format   : base64(salt[16] + iv[16] + ciphertext)
 */
import {
  pbkdf2Sync,
  createCipheriv,
  createDecipheriv,
  randomBytes,
} from "node:crypto";
import { pkcs7Pad, pkcs7Unpad } from "./pkcs7.ts";

const SALT_SIZE = 16;
const IV_SIZE = 16;
const ITERATIONS = 10000;
const KEY_SIZE = 32;

function deriveKey(password: string, salt: Buffer): Buffer {
  return pbkdf2Sync(Buffer.from(password, "utf8"), salt, ITERATIONS, KEY_SIZE, "sha256");
}

export const helm = {
  encrypt(text: string, password: string): string {
    const salt = randomBytes(SALT_SIZE);
    const iv = randomBytes(IV_SIZE);
    const key = deriveKey(password, salt);
    const cipher = createCipheriv("aes-256-cbc", key, iv);
    // We pad manually (to mirror the decrypt-side validation), so disable
    // Node's built-in PKCS padding to avoid an extra padding block.
    cipher.setAutoPadding(false);
    const ciphertext = Buffer.concat([
      cipher.update(pkcs7Pad(Buffer.from(text, "utf8"))),
      cipher.final(),
    ]);
    return Buffer.concat([salt, iv, ciphertext]).toString("base64");
  },

  decrypt(text: string, password: string): string {
    const raw = Buffer.from(text, "base64");
    const min = SALT_SIZE + IV_SIZE + 16;
    if (raw.length < min || (raw.length - SALT_SIZE - IV_SIZE) % 16 !== 0) {
      throw new Error("Invalid encrypted data");
    }
    const salt = raw.subarray(0, SALT_SIZE);
    const iv = raw.subarray(SALT_SIZE, SALT_SIZE + IV_SIZE);
    const ciphertext = raw.subarray(SALT_SIZE + IV_SIZE);
    const key = deriveKey(password, salt);
    const decipher = createDecipheriv("aes-256-cbc", key, iv);
    // Disable Node's built-in PKCS padding removal; we validate it ourselves.
    decipher.setAutoPadding(false);
    const padded = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return pkcs7Unpad(padded).toString("utf8");
  },
};
