/**
 * Helm-tab encryptor.
 *
 * NOTE: "Helm" here is an internal convention, NOT a real Helm format
 * (`helm secrets` delegates to SOPS/age/Vault).
 *
 * Two wire formats, told apart by their first characters:
 *
 *   v2 (written)   "helm:v2:" + base64(salt[16] + iv[12] + ciphertext + tag[16])
 *                  PBKDF2-HMAC-SHA256, 600 000 iterations, dklen 32
 *                  AES-256-GCM; the version string is bound in as AAD
 *
 *   v1 (read only) base64(salt[16] + iv[16] + ciphertext)
 *                  PBKDF2-HMAC-SHA256, 10 000 iterations, dklen 32
 *                  AES-256-CBC + PKCS#7 — no authentication
 *
 * v1 is what this tab used to write, and there is ciphertext in the wild that
 * only this code can open, so it is still decrypted. It is no longer produced:
 * CBC without a MAC lets anyone who can touch the stored text change the
 * plaintext in predictable ways without knowing the password (flip a bit in the
 * IV and the same bit flips in the first block), and 10 000 PBKDF2 rounds is
 * about sixty times below what OWASP now recommends for SHA-256.
 *
 * v1 cannot be confused with v2: base64 has no ":" in its alphabet.
 *
 * Built on WebCrypto rather than node:crypto so this exact module runs in the
 * browser too — which is what lets the password stay on the user's machine
 * instead of being posted anywhere.
 */
import { concat, fromBase64, fromUtf8, randomBytes, toBase64, utf8, type Bytes } from "./bytes.ts";

const SALT_SIZE = 16;
const V1_IV_SIZE = 16;
const V1_ITERATIONS = 10000;

const V2_PREFIX = "helm:v2:";
const V2_IV_SIZE = 12; // the size GCM is specified around; other sizes are hashed down
const V2_TAG_SIZE = 16;
const V2_ITERATIONS = 600000;
// Authenticated but not encrypted: a ciphertext cannot be re-labelled as another
// version and still open.
const V2_AAD = utf8("helm:v2");

const WRONG = "Invalid password or corrupted data";

async function deriveKey(
  password: string,
  salt: Bytes,
  iterations: number,
  algorithm: "AES-CBC" | "AES-GCM",
  usage: KeyUsage[],
): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey("raw", utf8(password), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt, iterations, hash: "SHA-256" },
    base,
    { name: algorithm, length: 256 },
    false,
    usage,
  );
}

async function decryptV1(text: string, password: string): Promise<string> {
  const raw = fromBase64(text);
  const min = SALT_SIZE + V1_IV_SIZE + 16;
  if (raw.length < min || (raw.length - SALT_SIZE - V1_IV_SIZE) % 16 !== 0) {
    throw new Error("Invalid encrypted data");
  }
  const salt = raw.subarray(0, SALT_SIZE);
  const iv = raw.subarray(SALT_SIZE, SALT_SIZE + V1_IV_SIZE);
  const ciphertext = raw.subarray(SALT_SIZE + V1_IV_SIZE);
  const key = await deriveKey(password, salt, V1_ITERATIONS, "AES-CBC", ["decrypt"]);
  try {
    const plain = await crypto.subtle.decrypt({ name: "AES-CBC", iv }, key, ciphertext);
    return fromUtf8(new Uint8Array(plain));
  } catch {
    // A wrong password fails as a padding error; there is nothing more
    // specific to report, and saying which would be a padding oracle.
    throw new Error(WRONG);
  }
}

async function decryptV2(text: string, password: string): Promise<string> {
  const raw = fromBase64(text.slice(V2_PREFIX.length));
  if (raw.length < SALT_SIZE + V2_IV_SIZE + V2_TAG_SIZE) throw new Error("Invalid encrypted data");
  const salt = raw.subarray(0, SALT_SIZE);
  const iv = raw.subarray(SALT_SIZE, SALT_SIZE + V2_IV_SIZE);
  const ciphertext = raw.subarray(SALT_SIZE + V2_IV_SIZE);
  const key = await deriveKey(password, salt, V2_ITERATIONS, "AES-GCM", ["decrypt"]);
  try {
    const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv, additionalData: V2_AAD, tagLength: V2_TAG_SIZE * 8 }, key, ciphertext);
    return fromUtf8(new Uint8Array(plain));
  } catch {
    // The tag covers the whole message, so a wrong password and a modified
    // ciphertext are the same failure — and always a failure, never garbage.
    throw new Error(WRONG);
  }
}

export const helm = {
  async encrypt(text: string, password: string): Promise<string> {
    const salt = randomBytes(SALT_SIZE);
    const iv = randomBytes(V2_IV_SIZE);
    const key = await deriveKey(password, salt, V2_ITERATIONS, "AES-GCM", ["encrypt"]);
    const sealed = new Uint8Array(
      await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: V2_AAD, tagLength: V2_TAG_SIZE * 8 }, key, utf8(text)),
    );
    return V2_PREFIX + toBase64(concat(salt, iv, sealed));
  },

  async decrypt(text: string, password: string): Promise<string> {
    const t = text.trim();
    if (t.startsWith(V2_PREFIX)) return decryptV2(t, password);
    // Anything else with a "helm:" label is a version this build does not know:
    // saying so is better than feeding it to the old format and reporting that
    // the base64 is bad.
    if (/^helm:v\d+:/.test(t)) throw new Error(`Unsupported helm format version: ${t.slice(0, t.indexOf(":", 5) + 1)}`);
    return decryptV1(t, password);
  },
};
