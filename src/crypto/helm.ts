/**
 * Helm-tab encryptor.
 *
 * NOTE: "Helm" here is an internal convention, NOT a real Helm format
 * (`helm secrets` delegates to SOPS/age/Vault).
 *
 *   Key derivation: PBKDF2-HMAC-SHA256, 10000 iterations, dklen 32
 *   Encryption    : AES-256-CBC + PKCS#7 padding
 *   Wire format   : base64(salt[16] + iv[16] + ciphertext)
 *
 * Built on WebCrypto rather than node:crypto so this exact module runs in the
 * browser too — which is what lets the password stay on the user's machine
 * instead of being posted to the server. The wire format is unchanged, so
 * ciphertext from the previous node:crypto implementation still decrypts.
 */
import { concat, fromBase64, fromUtf8, randomBytes, toBase64, utf8, type Bytes } from "./bytes.ts";

const SALT_SIZE = 16;
const IV_SIZE = 16;
const ITERATIONS = 10000;

async function deriveKey(password: string, salt: Bytes, usage: KeyUsage[]): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey("raw", utf8(password), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt, iterations: ITERATIONS, hash: "SHA-256" },
    base,
    { name: "AES-CBC", length: 256 },
    false,
    usage,
  );
}

export const helm = {
  async encrypt(text: string, password: string): Promise<string> {
    const salt = randomBytes(SALT_SIZE);
    const iv = randomBytes(IV_SIZE);
    const key = await deriveKey(password, salt, ["encrypt"]);
    // WebCrypto's AES-CBC always applies PKCS#7, which is exactly what the
    // previous implementation did by hand.
    const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-CBC", iv }, key, utf8(text)));
    return toBase64(concat(salt, iv, ciphertext));
  },

  async decrypt(text: string, password: string): Promise<string> {
    const raw = fromBase64(text);
    const min = SALT_SIZE + IV_SIZE + 16;
    if (raw.length < min || (raw.length - SALT_SIZE - IV_SIZE) % 16 !== 0) {
      throw new Error("Invalid encrypted data");
    }
    const salt = raw.subarray(0, SALT_SIZE);
    const iv = raw.subarray(SALT_SIZE, SALT_SIZE + IV_SIZE);
    const ciphertext = raw.subarray(SALT_SIZE + IV_SIZE);
    const key = await deriveKey(password, salt, ["decrypt"]);
    try {
      const plain = await crypto.subtle.decrypt({ name: "AES-CBC", iv }, key, ciphertext);
      return fromUtf8(new Uint8Array(plain));
    } catch {
      // A wrong password fails as a padding error; there is nothing more
      // specific to report, and saying which would be a padding oracle.
      throw new Error("Invalid password or corrupted data");
    }
  },
};
