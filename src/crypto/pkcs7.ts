/** PKCS#7 padding helpers (block size 16, shared by both encryptors). */

const BLOCK = 16;

export function pkcs7Pad(data: Buffer, block = BLOCK): Buffer {
  const padLen = block - (data.length % block);
  return Buffer.concat([data, Buffer.alloc(padLen, padLen)]);
}

export function pkcs7Unpad(data: Buffer): Buffer {
  if (data.length === 0) throw new Error("Empty data");
  const padLen = data[data.length - 1];
  if (padLen < 1 || padLen > BLOCK) {
    throw new Error(`Invalid PKCS#7 pad byte: ${padLen}`);
  }
  for (let i = data.length - padLen; i < data.length; i++) {
    if (data[i] !== padLen) throw new Error("Invalid PKCS#7 padding");
  }
  return data.subarray(0, data.length - padLen);
}
