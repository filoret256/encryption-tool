/** Crypto on WebCrypto: `bun run crypto:smoke`.
 *
 *  The encryptors moved from node:crypto to WebCrypto so the same modules can
 *  run in the browser. The thing that must not change is the wire format, so
 *  the checks that matter here are the cross-compatibility ones: the reference
 *  implementation below is the previous node:crypto code, and ciphertext has to
 *  pass in both directions between it and the new implementation.
 */
import { createCipheriv, createDecipheriv, createHmac, pbkdf2Sync, randomBytes, timingSafeEqual } from "node:crypto";
import { ansible, helm } from "../src/crypto/index.ts";

const results: { name: string; ok: boolean; note: string }[] = [];

function check(name: string, ok: boolean, note = ""): void {
  results.push({ name, ok, note });
  console.log(`${ok ? "  ok  " : "  FAIL"}  ${name}${note ? `  — ${note}` : ""}`);
}

// ── reference: the previous node:crypto implementation ────────────────────

const pad = (d: Buffer): Buffer => {
  const n = 16 - (d.length % 16);
  return Buffer.concat([d, Buffer.alloc(n, n)]);
};
const unpad = (d: Buffer): Buffer => d.subarray(0, d.length - d[d.length - 1]);

const refHelm = {
  encrypt(text: string, password: string): string {
    const salt = randomBytes(16);
    const iv = randomBytes(16);
    const key = pbkdf2Sync(Buffer.from(password, "utf8"), salt, 10000, 32, "sha256");
    const c = createCipheriv("aes-256-cbc", key, iv);
    c.setAutoPadding(false);
    const ct = Buffer.concat([c.update(pad(Buffer.from(text, "utf8"))), c.final()]);
    return Buffer.concat([salt, iv, ct]).toString("base64");
  },
  decrypt(text: string, password: string): string {
    const raw = Buffer.from(text, "base64");
    const salt = raw.subarray(0, 16);
    const iv = raw.subarray(16, 32);
    const key = pbkdf2Sync(Buffer.from(password, "utf8"), salt, 10000, 32, "sha256");
    const d = createDecipheriv("aes-256-cbc", key, iv);
    d.setAutoPadding(false);
    return unpad(Buffer.concat([d.update(raw.subarray(32)), d.final()])).toString("utf8");
  },
};

const refKeys = (password: string, salt: Buffer) => {
  const d = pbkdf2Sync(Buffer.from(password, "utf8"), salt, 10000, 80, "sha256");
  return { key: d.subarray(0, 32), hmacKey: d.subarray(32, 64), iv: d.subarray(64, 80) };
};

const refAnsible = {
  encrypt(text: string, password: string): string {
    const salt = randomBytes(32);
    const { key, hmacKey, iv } = refKeys(password, salt);
    const c = createCipheriv("aes-256-ctr", key, iv);
    const ct = Buffer.concat([c.update(pad(Buffer.from(text, "utf8"))), c.final()]);
    const mac = createHmac("sha256", hmacKey).update(ct).digest();
    const inner = salt.toString("hex") + "\n" + mac.toString("hex") + "\n" + ct.toString("hex");
    const hex2 = Buffer.from(inner, "ascii").toString("hex");
    const lines: string[] = [];
    for (let i = 0; i < hex2.length; i += 80) lines.push(hex2.slice(i, i + 80));
    return "$ANSIBLE_VAULT;1.1;AES256\n" + lines.join("\n");
  },
  decrypt(text: string, password: string): string {
    const parts = Buffer.from(text.trim().split("\n").slice(1).join(""), "hex").toString("ascii").split("\n");
    const [salt, mac, ct] = parts.map((p) => Buffer.from(p, "hex"));
    const { key, hmacKey, iv } = refKeys(password, salt);
    const expected = createHmac("sha256", hmacKey).update(ct).digest();
    if (!timingSafeEqual(mac, expected)) throw new Error("bad mac");
    const d = createDecipheriv("aes-256-ctr", key, iv);
    return unpad(Buffer.concat([d.update(ct), d.final()])).toString("utf8");
  },
};

// ── cases ─────────────────────────────────────────────────────────────────

const PW = "correct horse battery staple";
const SAMPLES: [string, string][] = [
  ["ascii", "hello world"],
  ["yaml", "db:\n  password: s3cret\n  host: example.com\n"],
  ["unicode", "пароль ключ 🔐 日本語"],
  ["one byte", "x"],
  ["exact block", "0123456789abcdef"],
  ["long", "lorem ipsum ".repeat(5000)],
];

try {
  for (const [label, text] of SAMPLES) {
    const h = await helm.decrypt(await helm.encrypt(text, PW), PW);
    const a = await ansible.decrypt(await ansible.encrypt(text, PW), PW);
    check("round trip: " + label, h === text && a === text, text.length + " chars, both schemes");
  }

  for (const [label, text] of SAMPLES.slice(0, 5)) {
    const fromRef = await helm.decrypt(refHelm.encrypt(text, PW), PW);
    const toRef = refHelm.decrypt(await helm.encrypt(text, PW), PW);
    check("helm interops with node:crypto: " + label, fromRef === text && toRef === text, "decrypts both ways");
  }
  for (const [label, text] of SAMPLES.slice(0, 5)) {
    const fromRef = await ansible.decrypt(refAnsible.encrypt(text, PW), PW);
    const toRef = refAnsible.decrypt(await ansible.encrypt(text, PW), PW);
    check("vault interops with node:crypto: " + label, fromRef === text && toRef === text, "decrypts both ways");
  }

  const vault = await ansible.encrypt("secret", PW);
  const lines = vault.split("\n");
  check(
    "vault envelope shape",
    lines[0] === "$ANSIBLE_VAULT;1.1;AES256" &&
      lines.slice(1, -1).every((l) => l.length === 80) &&
      lines.slice(1).every((l) => /^[0-9a-f]+$/.test(l)),
    lines.length - 1 + " hex lines wrapped at 80",
  );

  // The vault scheme authenticates with HMAC, so a wrong password is always
  // a clean, deterministic rejection.
  let vaultMsg = "";
  try {
    await ansible.decrypt(await ansible.encrypt("secret", PW), "wrong");
  } catch (e) {
    vaultMsg = e instanceof Error ? e.message : String(e);
  }
  check("vault: wrong password always rejected", vaultMsg === "Invalid password or corrupted data", vaultMsg || "no error thrown");

  // Helm is unauthenticated CBC: detection relies on the PKCS#7 padding being
  // wrong, which it is ~255/256 of the time. Asserting a single attempt throws
  // would be a test that fails once every few hundred runs. The invariant that
  // actually holds is that it never yields the real plaintext.
  const TRIES = 256;
  let threw = 0;
  let leaked = 0;
  for (let i = 0; i < TRIES; i++) {
    const secret = "secret payload " + i;
    try {
      const out = await helm.decrypt(await helm.encrypt(secret, PW), "wrong");
      if (out === secret) leaked++;
    } catch {
      threw++;
    }
  }
  check(
    "helm: wrong password never yields the plaintext",
    leaked === 0 && threw >= TRIES * 0.9,
    threw + "/" + TRIES + " rejected on padding, " + leaked + " leaked (CBC is unauthenticated by design)",
  );

  const body = vault.split("\n").slice(1).join("");
  const at = body.length - 8;
  const flipped = (parseInt(body[at], 16) ^ 1).toString(16);
  const tampered = "$ANSIBLE_VAULT;1.1;AES256\n" + body.slice(0, at) + flipped + body.slice(at + 1);
  let tamperMsg = "";
  try {
    await ansible.decrypt(tampered, PW);
  } catch (e) {
    tamperMsg = e instanceof Error ? e.message : String(e);
  }
  check("vault: tampered ciphertext rejected", tamperMsg.length > 0, tamperMsg);

  const bad: (() => Promise<unknown>)[] = [
    () => helm.decrypt("AAAA", PW),
    () => ansible.decrypt("not a vault", PW),
    () => ansible.decrypt("$ANSIBLE_VAULT;1.1;AES256\nabc", PW),
  ];
  const messages: string[] = [];
  for (const run of bad) {
    try {
      await run();
      messages.push("(no error)");
    } catch (e) {
      messages.push(e instanceof Error ? e.message : String(e));
    }
  }
  check("malformed input reports a clear error", messages.every((m) => m !== "(no error)"), messages.join(" | "));
} catch (e) {
  check("unexpected error", false, e instanceof Error ? e.message : String(e));
}

const failed = results.filter((r) => !r.ok);
console.log("\n" + (results.length - failed.length) + "/" + results.length + " passed");
process.exit(failed.length ? 1 : 0);
