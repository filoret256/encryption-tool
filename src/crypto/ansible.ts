/**
 * Ansible Vault compatible encryptor.
 *
 * Interoperable with the real `ansible-vault` CLI (format 1.1 / AES256):
 *   Header        : $ANSIBLE_VAULT;1.1;AES256
 *   Key derivation: PBKDF2-HMAC-SHA256, 10000 iterations, dklen 80 -> 32/32/16
 *   Encryption    : AES-256-CTR (iv = initial counter)
 *   Authentication: HMAC-SHA256 over the ciphertext
 *   Padding       : PKCS#7 (block 16)
 *   Encoding      : double hex of "saltHex\nmacHex\nctHex", wrapped at 80 cols
 *
 * On WebCrypto so the module also runs in the browser; the format is byte-for-
 * byte what the previous node:crypto version produced.
 */
import { fromHex, fromUtf8, randomBytes, timingSafeEqual, toHex, utf8, type Bytes } from "./bytes.ts";
import { pkcs7Pad, pkcs7Unpad } from "./pkcs7.ts";

const SALT_SIZE = 32;
const ITERATIONS = 10000;
const HEADER = "$ANSIBLE_VAULT;1.1;AES256";
const LINE_WIDTH = 80;

interface DerivedKeys {
  key: CryptoKey;
  hmacKey: CryptoKey;
  /** The initial AES-CTR counter block. */
  iv: Bytes;
}

async function deriveKeys(password: string, salt: Bytes): Promise<DerivedKeys> {
  const base = await crypto.subtle.importKey("raw", utf8(password), "PBKDF2", false, ["deriveBits"]);
  const bits = new Uint8Array(
    await crypto.subtle.deriveBits({ name: "PBKDF2", salt, iterations: ITERATIONS, hash: "SHA-256" }, base, 80 * 8),
  );
  // slice() rather than subarray(): importKey takes a BufferSource, and a view
  // that shares its buffer with the rest of the derived material is a trap.
  return {
    key: await crypto.subtle.importKey("raw", bits.slice(0, 32), { name: "AES-CTR" }, false, ["encrypt", "decrypt"]),
    hmacKey: await crypto.subtle.importKey("raw", bits.slice(32, 64), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]),
    iv: bits.slice(64, 80),
  };
}

/** The full 16-byte block is the counter, matching `aes-256-ctr` in OpenSSL
 *  and Node, which increment across all 128 bits. */
const ctrParams = (iv: Bytes): AesCtrParams => ({ name: "AES-CTR", counter: iv, length: 128 });

/** salt/mac/ciphertext -> Ansible Vault envelope (double hex, 80-col wrap). */
function format(salt: Bytes, mac: Bytes, ciphertext: Bytes): string {
  const inner = `${toHex(salt)}\n${toHex(mac)}\n${toHex(ciphertext)}`;
  const hexTwice = toHex(utf8(inner));
  const lines: string[] = [];
  for (let i = 0; i < hexTwice.length; i += LINE_WIDTH) lines.push(hexTwice.slice(i, i + LINE_WIDTH));
  return `${HEADER}\n${lines.join("\n")}`;
}

/** Parse envelope -> [salt, mac, ciphertext]. Line-wrap width is ignored. */
function parse(text: string): [Bytes, Bytes, Bytes] {
  const lines = text.trim().split(/\r?\n/);
  if (!lines[0].startsWith("$ANSIBLE_VAULT;")) throw new Error("Invalid header");
  const inner = fromUtf8(fromHex(lines.slice(1).join("").replace(/\s/g, "")));
  const parts = inner.split("\n");
  if (parts.length !== 3) {
    throw new Error(`Invalid vault format: expected 3 parts, got ${parts.length}`);
  }
  return [fromHex(parts[0]), fromHex(parts[1]), fromHex(parts[2])];
}

export const ansible = {
  async encrypt(text: string, password: string): Promise<string> {
    const salt = randomBytes(SALT_SIZE);
    const { key, hmacKey, iv } = await deriveKeys(password, salt);
    const padded = pkcs7Pad(utf8(text));
    const ciphertext = new Uint8Array(await crypto.subtle.encrypt(ctrParams(iv), key, padded));
    const mac = new Uint8Array(await crypto.subtle.sign("HMAC", hmacKey, ciphertext));
    return format(salt, mac, ciphertext);
  },

  async decrypt(text: string, password: string): Promise<string> {
    const [salt, mac, ciphertext] = parse(text);
    const { key, hmacKey, iv } = await deriveKeys(password, salt);
    const expected = new Uint8Array(await crypto.subtle.sign("HMAC", hmacKey, ciphertext));
    // Authenticate before decrypting: this is what makes a wrong password a
    // clean failure rather than a pile of garbage plaintext.
    if (!timingSafeEqual(mac, expected)) throw new Error("Invalid password or corrupted data");
    const padded = new Uint8Array(await crypto.subtle.decrypt(ctrParams(iv), key, ciphertext));
    return fromUtf8(pkcs7Unpad(padded));
  },
};
