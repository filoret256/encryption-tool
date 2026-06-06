/**
 * Ansible Vault compatible encryptor (TypeScript port of crypto/ansible.py).
 *
 * Interoperable with the real `ansible-vault` CLI (format 1.1 / AES256):
 *   Header        : $ANSIBLE_VAULT;1.1;AES256
 *   Key derivation: PBKDF2-HMAC-SHA256, 10000 iterations, dklen 80 -> 32/32/16
 *   Encryption    : AES-256-CTR (iv = initial counter)
 *   Authentication: HMAC-SHA256 over the ciphertext
 *   Padding       : PKCS#7 (block 16)
 *   Encoding      : double hex of "saltHex\nmacHex\nctHex", wrapped at 80 cols
 */
import {
  pbkdf2Sync,
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import { pkcs7Pad, pkcs7Unpad } from "./pkcs7.ts";

const SALT_SIZE = 32;
const ITERATIONS = 10000;
const HEADER = "$ANSIBLE_VAULT;1.1;AES256";
const LINE_WIDTH = 80;

interface DerivedKeys {
  key: Buffer;
  hmacKey: Buffer;
  iv: Buffer;
}

function deriveKeys(password: string, salt: Buffer): DerivedKeys {
  const d = pbkdf2Sync(Buffer.from(password, "utf8"), salt, ITERATIONS, 80, "sha256");
  return { key: d.subarray(0, 32), hmacKey: d.subarray(32, 64), iv: d.subarray(64, 80) };
}

/** salt/mac/ciphertext -> Ansible Vault envelope (double hex, 80-col wrap). */
function format(salt: Buffer, mac: Buffer, ciphertext: Buffer): string {
  const inner = `${salt.toString("hex")}\n${mac.toString("hex")}\n${ciphertext.toString("hex")}`;
  const hexTwice = Buffer.from(inner, "ascii").toString("hex");
  const lines: string[] = [];
  for (let i = 0; i < hexTwice.length; i += LINE_WIDTH) {
    lines.push(hexTwice.slice(i, i + LINE_WIDTH));
  }
  return `${HEADER}\n${lines.join("\n")}`;
}

/** Parse envelope -> [salt, mac, ciphertext]. Line-wrap width is ignored. */
function parse(text: string): [Buffer, Buffer, Buffer] {
  const lines = text.trim().split("\n");
  if (!lines[0].startsWith("$ANSIBLE_VAULT;")) {
    throw new Error("Invalid header");
  }
  const hexTwice = lines.slice(1).join("");
  const inner = Buffer.from(hexTwice, "hex").toString("ascii");
  const parts = inner.split("\n");
  if (parts.length !== 3) {
    throw new Error(`Invalid vault format: expected 3 parts, got ${parts.length}`);
  }
  return [
    Buffer.from(parts[0], "hex"),
    Buffer.from(parts[1], "hex"),
    Buffer.from(parts[2], "hex"),
  ];
}

export const ansible = {
  encrypt(text: string, password: string): string {
    const salt = randomBytes(SALT_SIZE);
    const { key, hmacKey, iv } = deriveKeys(password, salt);
    const padded = pkcs7Pad(Buffer.from(text, "utf8"));
    const cipher = createCipheriv("aes-256-ctr", key, iv);
    const ciphertext = Buffer.concat([cipher.update(padded), cipher.final()]);
    const mac = createHmac("sha256", hmacKey).update(ciphertext).digest();
    return format(salt, mac, ciphertext);
  },

  decrypt(text: string, password: string): string {
    const [salt, mac, ciphertext] = parse(text);
    const { key, hmacKey, iv } = deriveKeys(password, salt);
    const expected = createHmac("sha256", hmacKey).update(ciphertext).digest();
    if (mac.length !== expected.length || !timingSafeEqual(mac, expected)) {
      throw new Error("Invalid password or corrupted data");
    }
    const decipher = createDecipheriv("aes-256-ctr", key, iv);
    const padded = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return pkcs7Unpad(padded).toString("utf8");
  },
};
