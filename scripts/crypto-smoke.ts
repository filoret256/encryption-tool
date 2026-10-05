/** Crypto on WebCrypto: `bun run crypto:smoke`.
 *
 *  The encryptors moved from node:crypto to WebCrypto so the same modules can
 *  run in the browser. The thing that must not change is the wire format, so
 *  the checks that matter here are the cross-compatibility ones: the references
 *  below are independent node:crypto code, and ciphertext has to pass in both
 *  directions between them and the WebCrypto implementation.
 *
 *  Ansible Vault has one format, fixed by the CLI. The helm tab has two: v1 is
 *  what it used to write (CBC, no MAC, 10 000 rounds) and is still opened, v2
 *  is what it writes now (GCM, 600 000 rounds).
 *
 *  The same two schemes are what the kafka tab wraps a message's value in and
 *  opens it with (src/web/kafka/vault.ts), so that module is exercised here as
 *  well: what a value looks like has to be told apart from what it is not.
 */
import { createCipheriv, createDecipheriv, createHmac, pbkdf2Sync, randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync } from "node:fs";
import { ansible, helm } from "../src/crypto/index.ts";
import { decryptValue, detectVault, encryptValue } from "../src/web/kafka/vault.ts";

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

const refHelmV2 = {
  encrypt(text: string, password: string): string {
    const salt = randomBytes(16);
    const iv = randomBytes(12);
    const key = pbkdf2Sync(Buffer.from(password, "utf8"), salt, 600000, 32, "sha256");
    const c = createCipheriv("aes-256-gcm", key, iv);
    c.setAAD(Buffer.from("helm:v2"));
    const ct = Buffer.concat([c.update(Buffer.from(text, "utf8")), c.final()]);
    return "helm:v2:" + Buffer.concat([salt, iv, ct, c.getAuthTag()]).toString("base64");
  },
  decrypt(text: string, password: string): string {
    const raw = Buffer.from(text.slice("helm:v2:".length), "base64");
    const salt = raw.subarray(0, 16);
    const iv = raw.subarray(16, 28);
    const tag = raw.subarray(raw.length - 16);
    const key = pbkdf2Sync(Buffer.from(password, "utf8"), salt, 600000, 32, "sha256");
    const d = createDecipheriv("aes-256-gcm", key, iv);
    d.setAAD(Buffer.from("helm:v2"));
    d.setAuthTag(tag);
    return Buffer.concat([d.update(raw.subarray(28, raw.length - 16)), d.final()]).toString("utf8");
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

  // v2 against an independent implementation, both ways — 600 000 rounds each,
  // so three samples rather than five.
  for (const [label, text] of SAMPLES.slice(0, 3)) {
    const fromRef = await helm.decrypt(refHelmV2.encrypt(text, PW), PW);
    const toRef = refHelmV2.decrypt(await helm.encrypt(text, PW), PW);
    check("helm v2 interops with node:crypto: " + label, fromRef === text && toRef === text, "decrypts both ways");
  }
  // v1 is read-only now, and must stay readable: it is what the tab wrote until
  // this format existed, and the only thing that can open it is this code.
  for (const [label, text] of SAMPLES.slice(0, 5)) {
    const opened = await helm.decrypt(refHelm.encrypt(text, PW), PW);
    check("helm v1 (legacy) ciphertext still opens: " + label, opened === text, "written by the previous implementation");
  }
  const written = await helm.encrypt("shape", PW);
  const rawLen = Buffer.from(written.slice("helm:v2:".length), "base64").length;
  check("helm writes v2, not v1", written.startsWith("helm:v2:") && rawLen === 16 + 12 + "shape".length + 16, `${written.slice(0, 12)}… ${rawLen} bytes = salt 16 + iv 12 + 5 + tag 16`);
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

  // v2 is authenticated, so a wrong password is a deterministic rejection —
  // unlike v1, where detection rode on the CBC padding being wrong (~255/256).
  const messageOf = async (run: () => Promise<unknown>): Promise<string> => {
    try {
      await run();
      return "(no error)";
    } catch (e) {
      return e instanceof Error ? e.message : String(e);
    }
  };
  const sealed = await helm.encrypt("secret payload", PW);
  const wrong = await Promise.all(Array.from({ length: 8 }, () => messageOf(() => helm.decrypt(sealed, "wrong"))));
  check("helm v2: wrong password always rejected", wrong.every((m) => m === "Invalid password or corrupted data"), wrong[0]);

  // Every region of the message is covered: the version label, the salt (which
  // changes the key), the IV, the ciphertext and the tag. Before v2 the same
  // edit to the IV changed the plaintext without any error at all.
  const body = Buffer.from(sealed.slice("helm:v2:".length), "base64");
  const tamperAt = async (name: string, offset: number): Promise<void> => {
    const copy = Buffer.from(body);
    copy[offset] ^= 1;
    const msg = await messageOf(() => helm.decrypt("helm:v2:" + copy.toString("base64"), PW));
    check(`helm v2: a changed ${name} is rejected`, msg === "Invalid password or corrupted data", msg);
  };
  await tamperAt("salt byte", 0);
  await tamperAt("IV byte", 16);
  await tamperAt("ciphertext byte", 28);
  await tamperAt("tag byte", body.length - 1);
  const relabelled = await messageOf(() => helm.decrypt("helm:v3:" + sealed.slice("helm:v2:".length), PW));
  check("helm: an unknown version is named, not misread", /^Unsupported helm format version: helm:v3:$/.test(relabelled), relabelled);
  const truncated = await messageOf(() => helm.decrypt("helm:v2:AAAA", PW));
  check("helm v2: a truncated message is rejected", truncated === "Invalid encrypted data", truncated);
  check("helm v2: surrounding whitespace is tolerated", (await helm.decrypt(`\n  ${sealed}  \n`, PW)) === "secret payload", "pasted text often carries it");

  const vaultBody = vault.split("\n").slice(1).join("");
  const at = vaultBody.length - 8;
  const flipped = (parseInt(vaultBody[at], 16) ^ 1).toString(16);
  const tampered = "$ANSIBLE_VAULT;1.1;AES256\n" + vaultBody.slice(0, at) + flipped + vaultBody.slice(at + 1);
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

  // ── the kafka tab: a value wrapped, and read back ───────────────────────
  // A message's value is bytes; the page decides they are text and then decides
  // whether the text is an envelope. The password never leaves that page, so all
  // of this runs in the same place the viewer does.
  const wrapped = await encryptValue("ansible", "db: s3cret", PW);
  check("a value wrapped as a vault is recognised as one", detectVault(wrapped) === "ansible", wrapped.split("\n")[0]);
  check(
    "a wrapped value opens again",
    (await decryptValue("ansible", wrapped, PW)) === "db: s3cret",
    "what the send dialog writes, the viewer reads",
  );
  const sealedValue = await encryptValue("helm", "db: s3cret", PW);
  check("a value wrapped as helm is recognised as one", detectVault(sealedValue) === "helm", sealedValue.slice(0, 12) + "…");
  check("a helm-wrapped value opens again", (await decryptValue("helm", sealedValue, PW)) === "db: s3cret");
  // A value from a message can carry the newline it was stored with.
  check("surrounding whitespace is tolerated", (await decryptValue("helm", `\n ${sealedValue} \n`, PW)) === "db: s3cret");
  const wrongOnValue = await messageOf(() => decryptValue("ansible", wrapped, "wrong"));
  check("a wrapped value with the wrong password is rejected", wrongOnValue === "Invalid password or corrupted data", wrongOnValue);

  // Guessing is the dangerous half: a prompt in front of ordinary messages is
  // worse than no detection at all. Only a value that says what it is counts.
  const notEnvelopes: [string, string][] = [
    ["plain text", "db: s3cret"],
    ["json", '{"db":"s3cret"}'],
    ["a bare base64 string", refHelm.encrypt("db: s3cret", PW)],
    ["empty", ""],
    ["a helm label of a version this build does not know", "helm:v9:AAAA"],
  ];
  for (const [what, text] of notEnvelopes) {
    // The last one is labelled and must be opened (and refused) rather than ignored.
    const want = what.startsWith("a helm label") ? "helm" : null;
    check(`not taken for an envelope: ${what}`, detectVault(text) === want, String(detectVault(text)));
  }
  const legacy = await decryptValue("helm", refHelm.encrypt("db: s3cret", PW), PW).then(
    (text) => text,
    (e: unknown) => `error: ${e instanceof Error ? e.message : String(e)}`,
  );
  check("a helm v1 value is opened when the reader asks for helm", legacy === "db: s3cret", "the format is chosen by hand, not guessed");

  // ── the crypto worker (P4) ──────────────────────────────────────────────
  // The vault's hex work runs on a thread of its own (src/web/crypto/worker.ts). What is
  // checked here is the protocol across that boundary and the thing that must not change
  // with it: what one side writes, the other reads.
  check(
    "the crypto worker bundle is built",
    existsSync("public/crypto-worker.js"),
    "run `bun run build` first — the page fetches this file by name",
  );
  if (existsSync("public/crypto-worker.js")) {
    const worker = new Worker(new URL("../public/crypto-worker.js", import.meta.url).href);
    let nextJob = 1;
    const ask = (job: Record<string, unknown>): Promise<{ ok: boolean; out?: string; error?: string }> =>
      new Promise((resolve, reject) => {
        const id = nextJob++;
        const onMessage = (ev: MessageEvent): void => {
          const reply = ev.data as { id: number };
          if (reply.id !== id) return;
          worker.removeEventListener("message", onMessage);
          resolve(ev.data as { ok: boolean; out?: string; error?: string });
        };
        const onError = (e: ErrorEvent): void => reject(new Error(e.message || "the worker failed"));
        worker.addEventListener("message", onMessage);
        worker.addEventListener("error", onError, { once: true });
        worker.postMessage({ id, ...job });
      });

    const byWorker = await ask({ kind: "crypto", tab: "ansible", action: "encrypt", text: "db: s3cret", password: PW });
    check("the worker encrypts a vault", byWorker.ok === true && typeof byWorker.out === "string", byWorker.error ?? "");
    check("what the worker wrote, this thread opens", (await ansible.decrypt(byWorker.out ?? "", PW)) === "db: s3cret");
    const byThread = await ansible.encrypt("db: s3cret", PW);
    const back = await ask({ kind: "crypto", tab: "ansible", action: "decrypt", text: byThread, password: PW });
    check("what this thread wrote, the worker opens", back.ok === true && back.out === "db: s3cret", back.error ?? "");
    const sealedByWorker = await ask({ kind: "crypto", tab: "helm", action: "encrypt", text: "db: s3cret", password: PW });
    check("the worker seals helm too", (await helm.decrypt(sealedByWorker.out ?? "", PW)) === "db: s3cret", sealedByWorker.error ?? "");
    const wrongInWorker = await ask({ kind: "crypto", tab: "ansible", action: "decrypt", text: byThread, password: "wrong" });
    check(
      "a wrong password comes back as the scheme's own sentence",
      wrongInWorker.ok === false && wrongInWorker.error === "Invalid password or corrupted data",
      String(wrongInWorker.error),
    );
    // The size the fix is about: a megabyte of text, encrypted and opened again through the
    // worker. It is the hex of crypto/bytes.ts on both sides that makes this work at all.
    const big = "x".repeat(1024 * 1024);
    const bigSealed = await ask({ kind: "crypto", tab: "ansible", action: "encrypt", text: big, password: PW });
    const bigBack = await ask({ kind: "crypto", tab: "ansible", action: "decrypt", text: bigSealed.out ?? "", password: PW });
    check(
      "a megabyte goes through the worker and comes back",
      bigSealed.ok === true && bigBack.ok === true && bigBack.out === big,
      bigSealed.error ?? bigBack.error ?? "",
    );

    // ── the jobs that joined it (P17) ──────────────────────────────────────
    // Base64 and YAML beautify walk the whole buffer, so they ride the same
    // worker. What is checked is the protocol and the two conversions.
    const encoded = await ask({ kind: "b64encode", text: "hello\nworld\n", unix: true });
    check(
      "the worker encodes base64",
      encoded.ok === true && encoded.out === btoa("hello\nworld\n"),
      encoded.error ?? String(encoded.out),
    );
    const crlf = await ask({ kind: "b64encode", text: "a\r\nb", unix: true });
    check(
      "and the unix button means what it says",
      crlf.ok === true && crlf.out === btoa("a\nb"),
      crlf.error ?? String(crlf.out),
    );
    const roundTrip = await ask({ kind: "b64decode", text: `${encoded.out ?? ""}\n` });
    check(
      "and decodes it again, whitespace and all",
      roundTrip.ok === true && roundTrip.out === "hello\nworld\n",
      roundTrip.error ?? JSON.stringify(roundTrip.out),
    );
    // Not base64: the worker's own refusal has to come back as a failure and not
    // as an empty buffer, which is how a page would silently lose the text.
    const bad = await ask({ kind: "b64decode", text: "not base64 at all!" });
    check("a decode that cannot work says so", bad.ok === false && typeof bad.error === "string", bad.error ?? String(bad.out));
    const tidy = await ask({ kind: "beautify", text: "b:   2\na:  1\n" });
    check("the worker beautifies YAML", tidy.ok === true && tidy.out === "b: 2\na: 1\n", tidy.error ?? JSON.stringify(tidy.out));
    const broken = await ask({ kind: "beautify", text: "a: [1,\n" });
    check("and a YAML error comes back as a message", broken.ok === false && typeof broken.error === "string", broken.error ?? String(broken.out));
    worker.terminate();
  }
} catch (e) {
  check("unexpected error", false, e instanceof Error ? e.message : String(e));
}

const failed = results.filter((r) => !r.ok);
console.log("\n" + (results.length - failed.length) + "/" + results.length + " passed");
process.exit(failed.length ? 1 : 0);
