/** PKCS#7 padding (block size 16).
 *
 *  Only the Ansible Vault scheme needs these: AES-CTR is a stream cipher and
 *  pads nothing, while WebCrypto's AES-CBC applies and strips PKCS#7 itself.
 */
import { concat, type Bytes } from "./bytes.ts";

const BLOCK = 16;

export function pkcs7Pad(data: Bytes, block = BLOCK): Bytes {
  const padLen = block - (data.length % block);
  return concat(data, new Uint8Array(padLen).fill(padLen));
}

export function pkcs7Unpad(data: Bytes): Bytes {
  if (data.length === 0) throw new Error("Empty data");
  const padLen = data[data.length - 1];
  if (padLen < 1 || padLen > BLOCK || padLen > data.length) {
    throw new Error(`Invalid PKCS#7 pad byte: ${padLen}`);
  }
  for (let i = data.length - padLen; i < data.length; i++) {
    if (data[i] !== padLen) throw new Error("Invalid PKCS#7 padding");
  }
  return data.subarray(0, data.length - padLen);
}
