/** Toolbar wiring for the CodeMirror-based UI. Replaces the ~1,250 lines of inline JS. */
import "./style.css";
import { TabEditor, type Tab, type ViewPrefs } from "./editor.ts";
import { YAML_LINT_MAX, yamlDiagnostics, yamlTooLarge } from "./yaml-lint.ts";
import { utf8Length } from "./text-size.ts";
import { prefersDark, rememberTheme, watchSystemTheme } from "./theme.ts";
import { mountNotifier, type Notice } from "./notify.ts";
import { ansible, helm } from "../crypto/index.ts";
import { runOffload } from "./crypto/offload.ts";
import type { JobSpec } from "./worker-jobs.ts";
import { CodeAgentClient } from "./code/code-agent.ts";
import { mountBadge } from "./code/caps.ts";
import { mountCodeAgentDownload, mountKafkaAgentDownload, type AgentDownload } from "./code/download.ts";
import type { CodeTab } from "./code.ts";
import type { KafkaTab } from "./kafka.ts";
import { KafkaAgentClient } from "./kafka/kafka-agent.ts";
import { mountKafkaBadge } from "./kafka/caps.ts";

/** The code and kafka tabs are not crypto tabs — each has its own layout and no
 *  editor in `editors`, so anything indexing by Tab must exclude them. */
type AnyTab = Tab | "kafka" | "code";
const TABS: AnyTab[] = ["ansible", "helm", "code", "kafka"];
const isCryptoTab = (tab: AnyTab): tab is Tab => tab === "ansible" || tab === "helm";

const editors = {} as Record<Tab, TabEditor>;
let currentTab: AnyTab = "ansible";
let isDark = false;

// The code-agent client lives in the main bundle so the capability badge is correct
// from first paint, before the code chunk is ever fetched.
const codeAgent = new CodeAgentClient(() => onCodeAgentState());
let codeTab: CodeTab | null = null;
/** The tab's mount, while it is happening. See openCodeTab. */
let codeMount: Promise<void> | null = null;
let refreshBadge: (() => void) | null = null;
let codeAgentDownload: AgentDownload | null = null;
let kafkaAgentDownload: AgentDownload | null = null;
let kafkaTab: KafkaTab | null = null;
/** The kafka tab's mount, while it is happening. */
let kafkaMount: Promise<void> | null = null;

// The kafka-agent's client lives here too, so that the saved URL is reconnected
// as the page loads — and the tab, when it is first opened, finds it already online.
let refreshKafkaBadge: (() => void) | null = null;
const kafkaAgent = new KafkaAgentClient(() => {
  refreshKafkaBadge?.();
  kafkaTab?.onAgentState();
});
kafkaAgent.onClusters = () => refreshKafkaBadge?.();

// ── Notifications ──
// A stack, not a slot: see notify.ts for why an error may not expire on a
// timer and why "saved" must not erase what git just said.
const notifier = mountNotifier(document.getElementById("toasts")!);

function toast(msg: string, isError = false): void {
  notifier.show({ message: msg, isError });
}

/** The richer form, used by the code tab: a one-line summary plus a way into
 *  the output log for whatever did not fit. */
function notify(notice: Notice): void {
  notifier.show(notice);
}

// ── Crypto ──
// Runs here on WebCrypto; the server has no crypto endpoints.
// Two reasons: the password never leaves this machine, and the crypto tabs keep
// working with no network at all, which is what makes the installed app
// genuinely offline.
const SCHEMES: Record<Tab, { encrypt(text: string, password: string): Promise<string>; decrypt(text: string, password: string): Promise<string> }> = {
  ansible,
  helm,
};

function pw(tab: Tab): string {
  return (document.getElementById(`${tab}-password`) as HTMLInputElement).value;
}

/** The result pane, when the tab is in two-pane mode. */
const results = {} as Record<Tab, TabEditor>;
const twoPane = { ansible: false, helm: false } as Record<Tab, boolean>;

/** Source on the left, result on the right.
 *
 *  In one pane the result replaces what you typed, which is recoverable but
 *  still means the plaintext and the ciphertext are never on screen together —
 *  and checking that an envelope decrypts back to what you meant took two
 *  operations and a memory. */
function toggleTwoPane(tab: Tab, btn: HTMLElement): void {
  twoPane[tab] = !twoPane[tab];
  btn.classList.toggle("is-active", twoPane[tab]);
  const host = document.getElementById(`${tab}-editor2`)!;
  host.hidden = !twoPane[tab];
  if (twoPane[tab]) {
    // Built on first use: a second CodeMirror per tab is not worth creating for
    // the people who never turn this on.
    results[tab] ??= new TabEditor(tab, host, "the result appears here", true);
    results[tab].setTheme(isDark);
    results[tab].refresh();
  }
}

async function cryptoAction(tab: Tab, action: "encrypt" | "decrypt"): Promise<void> {
  const password = pw(tab);
  // A selection means "this part", the way it does in every other editor. With
  // nothing selected it is the whole buffer, which is what it always was — so
  // the gesture is an addition, not a change of meaning.
  const selected = editors[tab].selectedText;
  const text = selected || editors[tab].value;
  if (!text.trim()) return toast("Text is required", true);
  if (!password) return toast("Password is required", true);
  // One at a time per tab. Without this, a second Ctrl+E while the first is running started
  // a second chain over the same buffer: two envelopes, twice the memory, and whichever
  // finished last won the editor.
  if (busyTabs.has(tab)) return toast(`${busyTabs.get(tab)} is still running`, true);
  // The limit is about memory, not about time, and it follows the direction: what is
  // encrypted is text (measured in bytes, because that is what the memory follows), and
  // what is decrypted is an envelope, which is about four characters per byte of that
  // text. One limit for both was wrong in a way that broke the tab's own round trip: a
  // 9 MB buffer became a 38 MB envelope, and the tool then refused to open what it had
  // just written. See MAX_ENVELOPE_BYTES.
  // What is encrypted is the text exactly as it is: a leading indent and the final
  // line break are part of it, and trimming them meant the round trip gave back a
  // different file. The trim above only answers "is there anything at all"; an
  // envelope, on the way back, is trimmed by its own parser (crypto/ansible.ts, helm.ts).
  const body = action === "encrypt" ? text : text.trim();
  const limit = action === "encrypt" ? MAX_CRYPTO_BYTES : MAX_ENVELOPE_BYTES;
  const bytes = utf8Length(body);
  if (bytes > limit) {
    return toast(
      action === "encrypt"
        ? `Too much text: ${mib(bytes)} MB, and the limit is ${mib(MAX_CRYPTO_BYTES)} MB of plaintext. Encrypt it in parts.`
        : `Too much ciphertext: ${mib(bytes)} MB, and the limit is ${mib(MAX_ENVELOPE_BYTES)} MB — more than the envelope of the largest text this tool encrypts.`,
      true,
    );
  }
  busyTabs.set(tab, action === "encrypt" ? "Encrypting" : "Decrypting");
  setCryptoBusy(tab, action);
  // What the job was handed, and where: the result goes back to the same place, and only if
  // that place still holds what it held (see writeResult).
  const at = editors[tab].selectionRange;
  const source: JobSource = selected
    ? { from: at.from, to: at.to, text: selected, whole: false }
    : { from: 0, to: editors[tab].length, text, whole: true };
  try {
    // Off the main thread: see crypto/offload.ts. The worker falls back to this thread if
    // it cannot be started, which is why the limit above is not merely advisory.
    const out = await runOffload({ kind: "crypto", tab, action, text: body, password });
    if (twoPane[tab]) {
      // The source is left exactly as it is; the result goes beside it.
      results[tab].value = out;
      toast(`${action}ed ${selected ? "the selection" : "the buffer"} → right pane`);
      return;
    }
    // The result replaces what was there. That is recoverable — Ctrl+Z — and
    // saying so is the difference between a tool that overwrote your text and
    // one that transformed it.
    writeResult(tab, source, out, `${action}ed ${selected ? "the selection" : "the buffer"} · Ctrl+Z puts it back`);
  } catch (e) {
    toast(e instanceof Error ? e.message : String(e), true);
  } finally {
    busyTabs.delete(tab);
    setCryptoBusy(tab, null);
  }
}

/** How much plaintext one encryption will take, in bytes.
 *
 *  The old shape had no limit at all, and 10 MiB was already seconds of frozen interface;
 *  20 MiB took the process with it on the stand (the OOM killer, not a slow tab). */
const MAX_CRYPTO_BYTES = 16 * 1024 * 1024;

/** And how much ciphertext one decryption will take.
 *
 *  An Ansible Vault envelope is the payload's hex a second time — about four characters per
 *  byte of plaintext — so the envelope of the largest text above is already ~64 MB. A
 *  single limit meant the tool could encrypt a buffer and then refuse to decrypt it, which
 *  is what a 9 MB file did: 38,272,789 characters of envelope against a 16,777,216 limit.
 *  Helm's base64 is smaller (4/3), so this covers both schemes. */
const MAX_ENVELOPE_BYTES = 4 * MAX_CRYPTO_BYTES + 1024;

/** Megabytes, for a sentence about a size. */
const mib = (bytes: number): string => (bytes / (1024 * 1024)).toFixed(1);

/** The tabs with a job running, and what it is. One flag for every job a tab can start —
 *  encrypt, decrypt, base64, beautify: two of them over the same buffer finish in either order,
 *  and whichever finishes last wins the editor, whichever button started it. */
const busyTabs = new Map<Tab, string>();

/** Where a job's text came from: the whole buffer, or a range of it. */
interface JobSource {
  from: number;
  to: number;
  text: string;
  whole: boolean;
}

/** Write a job's result back where its text came from — if that place still holds the text.
 *
 *  The job runs on a worker and the page stays live, so the person may type while it runs. A
 *  result written over that is the work of the last few seconds gone without a word; so when
 *  the text has moved on, the result waits for an answer instead. */
function writeResult(tab: Tab, source: JobSource, out: string, done: string): void {
  const ed = editors[tab];
  const put = (): void => {
    ed.replaceRange(source.from, source.to, out);
    flushStats(tab);
    toast(done);
  };
  const same = source.whole ? ed.value === source.text : ed.sliceText(source.from, source.to) === source.text;
  if (same) return put();
  notify({
    message: `The ${tab} text changed while this ran. Replace ${source.whole ? "it" : "the selection"} with the result?`,
    actions: [
      { label: "replace", run: put },
      { label: "keep", run: () => toast("Kept your text; the result was dropped") },
    ],
    sticky: true,
  });
}

/** The two buttons of one tab, while its work runs: out of service, and saying what it is
 *  doing. Which tab is running is the only thing that changes — the other tab is its own. */
function setCryptoBusy(tab: Tab, action: "encrypt" | "decrypt" | null): void {
  for (const kind of ["encrypt", "decrypt"] as const) {
    const btn = document.querySelector<HTMLButtonElement>(`[data-action="${kind}"][data-tab="${tab}"]`);
    if (!btn) continue;
    if (action !== null) {
      if (btn.dataset.label === undefined) btn.dataset.label = btn.textContent ?? "";
      btn.disabled = true;
      btn.textContent = kind === "encrypt" ? "encrypting…" : "decrypting…";
    } else {
      btn.disabled = false;
      if (btn.dataset.label !== undefined) btn.textContent = btn.dataset.label;
    }
  }
}

// ── YAML validity: inline lint toggle + badge (all client-side now) ──
const lintOn = { ansible: false, helm: false } as Record<Tab, boolean>;

function toggleLint(tab: Tab, btn: HTMLElement): void {
  lintOn[tab] = !lintOn[tab];
  editors[tab].setLint(lintOn[tab]);
  btn.classList.toggle("is-active", lintOn[tab]);
  updateBadge(tab);
}

/** `value` is the text when the caller already has it: reading the document is a copy of it. */
function updateBadge(tab: Tab, value?: string): void {
  const badge = document.getElementById(`${tab}-yaml-badge`)!;
  if (!lintOn[tab]) {
    badge.textContent = "";
    badge.className = "yaml-badge";
    return;
  }
  const text = value ?? editors[tab].value;
  // Not "valid": it was not looked at. Saying so is the difference between a check and a guess.
  if (yamlTooLarge(text)) {
    badge.textContent = "too large to check";
    badge.title = `The check reads texts up to ${YAML_LINT_MAX / 1024} KB; this one is ${Math.round(text.length / 1024)} KB.`;
    badge.className = "yaml-badge";
    return;
  }
  badge.removeAttribute("title");
  const errors = yamlDiagnostics(text);
  badge.textContent = errors.length ? `✗ ${errors.length}` : "✓ valid";
  badge.className = "yaml-badge " + (errors.length ? "bad" : "ok");
}

function yamlBeautify(tab: Tab, el: HTMLElement | null): Promise<void> {
  return runTransform(tab, el, { busy: "beautifying…", done: "beautified", fail: "YAML beautify failed" }, {
    kind: "beautify",
    text: editors[tab].value,
  });
}

// ── Base64 ──
//
// Both directions walk the whole buffer, so both go to the worker: on the main thread a
// 10 MB buffer is seconds of a page that answers nothing. See worker-jobs.ts for the
// conversions themselves, and for why the decode is a loop rather than `Uint8Array.from`.

function b64Encode(tab: Tab, el: HTMLElement | null, unix: boolean): Promise<void> {
  return runTransform(tab, el, { busy: "encoding…", done: "encoded", fail: "Base64 encode failed" }, {
    kind: "b64encode",
    text: editors[tab].value,
    unix,
  });
}

function b64Decode(tab: Tab, el: HTMLElement | null): Promise<void> {
  return runTransform(tab, el, { busy: "decoding…", done: "decoded", fail: "Base64 decode failed" }, {
    kind: "b64decode",
    text: editors[tab].value,
  });
}

/** One whole-buffer transform, on the worker, one at a time per tab.
 *
 *  Without the guard, a second click while the first is running starts a second job over
 *  the buffer as it was when it was clicked: two round trips, and whichever answers last
 *  wins the editor. The button says what is happening, because the work is now somewhere
 *  the page cannot see. */
async function runTransform(
  tab: Tab,
  el: HTMLElement | null,
  words: { busy: string; done: string; fail: string },
  spec: JobSpec,
): Promise<void> {
  if (busyTabs.has(tab)) return toast(`${busyTabs.get(tab)} is still running`, true);
  busyTabs.set(tab, words.busy.replace("…", "").replace(/^./, (c) => c.toUpperCase()));
  const source: JobSource = { from: 0, to: editors[tab].length, text: editors[tab].value, whole: true };
  const label = el?.textContent ?? "";
  if (el) {
    el.textContent = words.busy;
    el.setAttribute("aria-busy", "true");
  }
  try {
    writeResult(tab, source, await runOffload(spec), words.done);
  } catch (e) {
    toast(`${words.fail}: ${e instanceof Error ? e.message : String(e)}`, true);
  } finally {
    busyTabs.delete(tab);
    if (el) {
      el.textContent = label;
      el.removeAttribute("aria-busy");
    }
  }
}

// ── File IO ──

/** The largest file this tool will open.
 *
 *  Reading a file means a string of its size, a CodeMirror rope around it, a statistics
 *  pass over the lot — and then the plaintext is too big to encrypt anyway. A 200 MB file
 *  was read, became a 200 MB string, and froze the tab; the honest answer is no, with the
 *  size in it. */
const MAX_FILE_BYTES = 32 * 1024 * 1024;

function loadFile(tab: Tab): void {
  const input = document.getElementById("file-input") as HTMLInputElement;
  input.onchange = () => {
    const file = input.files?.[0];
    input.value = "";
    if (!file) return;
    if (file.size > MAX_FILE_BYTES) {
      return toast(
        `${file.name} is ${mib(file.size)} MB, and this tool opens files up to ${mib(MAX_FILE_BYTES)} MB. Encrypt it in parts.`,
        true,
      );
    }
    const reader = new FileReader();
    reader.onload = () => {
      editors[tab].value = String(reader.result);
      toast(`loaded ${file.name}`);
    };
    // A read can fail — the file moved, the disk gave up, the browser refused — and
    // without this the button did nothing at all and said nothing about it.
    reader.onerror = () => toast(`could not read ${file.name}: ${reader.error?.message ?? "the read failed"}`, true);
    reader.readAsText(file);
  };
  input.click();
}

function saveFile(tab: Tab): void {
  const blob = new Blob([editors[tab].value], { type: "text/plain" });
  const a = document.createElement("a");
  const url = URL.createObjectURL(blob);
  a.href = url;
  a.download = `${tab}-output.txt`;
  a.click();
  // Not in the same tick: some browsers start the download after the click returns,
  // and a link revoked by then saves nothing. The same wait as the kafka export.
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

async function copyText(tab: Tab): Promise<void> {
  try {
    await navigator.clipboard.writeText(editors[tab].value);
    toast("copied");
  } catch {
    toast("Copy failed", true);
  }
}

function clearText(tab: Tab): void {
  editors[tab].value = "";
  editors[tab].focus();
}

// ── View toggles ──
function toggleView(tab: Tab, kind: keyof ViewPrefs, btnId: string): void {
  const on = editors[tab].toggle(kind);
  document.getElementById(btnId)!.classList.toggle("is-active", on);
}

// ── Theme ──
/** `remember` separates "the user picked this" from "the system moved": only a
 *  press of the toggle writes a choice down, and only a written choice stops
 *  the app from following the desktop (see theme.ts). */
function applyTheme(dark: boolean, remember = true): void {
  isDark = dark;
  // The toggle visuals (track colour + knob slide) are driven by this attribute.
  document.documentElement.setAttribute("data-theme", dark ? "dark" : "light");
  Object.values(editors).forEach((e) => e.setTheme(dark));
  codeTab?.setTheme(dark);
  kafkaTab?.setTheme(dark);
  if (remember) rememberTheme(dark);
}

// ── Tabs ──

/** Show one tab, opening it if it has a chunk of its own.
 *
 *  It returns the tab's mount so that a caller which needs the tab to exist —
 *  the badge, which connects it — can wait for the same mount instead of
 *  starting a second one. */
function switchTab(tab: AnyTab): Promise<void> {
  currentTab = tab;
  if ((tab === "ansible" || tab === "helm") && statsStale.delete(tab)) flushStats(tab);
  for (const t of TABS) {
    document.getElementById(`${t}-tab`)!.classList.toggle("active", t === tab);
    document.querySelector(`.tab-${t}`)!.classList.toggle("active", t === tab);
  }
  // Nothing but the editor needs a local code-agent, so the download button and the
  // capability badge only appear where they mean something.
  document.getElementById("code-tools")!.hidden = tab !== "code";
  codeAgentDownload?.setVisible(tab === "code");
  kafkaAgentDownload?.setVisible(tab === "kafka");
  // A live tail is a stream nobody is watching once the tab is left.
  if (tab !== "kafka") kafkaTab?.setActive(false);
  // The same for the kafka-agent, beside its own tab.
  document.getElementById("kafka-tools")!.hidden = tab !== "kafka";
  if (tab === "code") return openCodeTab();
  if (tab === "kafka") {
    kafkaTab?.setActive(true);
    return openKafkaTab();
  }
  editors[tab].refresh();
  editors[tab].focus();
  return Promise.resolve();
}

// ── Code tab (lazily loaded chunk) ──
function onCodeAgentState(): void {
  refreshBadge?.();
  codeTab?.onCodeAgentState();
}

/** Open the code tab, mounting it at most once.
 *
 *  Two callers can arrive before the chunk has loaded: the tab button through
 *  `switchTab`, and the badge, which wants the tab open and connected. The
 *  guard used to be on `codeTab`, which is only set *after* `await import(...)`,
 *  so both callers passed it and both mounted — the second replaced the
 *  markup, and the first one's window listeners and `fs.change` subscription
 *  stayed behind, holding the whole editor stack alive, costing the tab about
 *  twice the memory and handling every resize and every watcher event twice.
 *
 *  The promise is what makes the second caller wait for the first. */
function openCodeTab(): Promise<void> {
  codeMount ??= mountCodeTabOnce();
  return codeMount;
}

async function mountCodeTabOnce(): Promise<void> {
  const host = document.getElementById("code-tab")!;
  // A remount cannot happen while the promise above is in place; this is what
  // makes that a guarantee rather than a hope, and it is why the tab has a
  // dispose() at all.
  codeTab?.dispose();
  codeTab = null;
  host.innerHTML = `<div class="code-loading">loading editor…</div>`;
  try {
    // The specifier is a variable so the bundler leaves it as a runtime
    // import instead of inlining the chunk back into main.js.
    const url = "/public/code.js";
    const mod = (await import(url)) as typeof import("./code.ts");
    codeTab = mod.mountCodeTab(host, {
      codeAgent,
      isDark: () => isDark,
      notify,
      dismissNotices: () => notifier.dismissAll(),
      dismissScope: (scope) => notifier.dismissScope(scope),
      onCapsChanged: () => refreshBadge?.(),
      getCodeAgent: () => codeAgentDownload?.open(),
    });
    codeTab.setTheme(isDark);
  } catch (e) {
    // textContent rather than a template into innerHTML: the message comes
    // from a failed dynamic import, so its wording is not ours, and there is
    // no markup wanted here anyway.
    host.replaceChildren();
    const note = document.createElement("div");
    note.className = "code-loading";
    note.textContent = `could not load the editor: ${e instanceof Error ? e.message : String(e)}`;
    host.appendChild(note);
    // A chunk that did not load is worth another try: leaving the promise in
    // place would make one failed import permanent for the session.
    codeMount = null;
    return;
  }
  codeTab.focus();
}

// ── Kafka tab (lazily loaded chunk) ──
/** As openCodeTab: one mount, shared by everyone who asks for the tab. */
function openKafkaTab(): Promise<void> {
  kafkaMount ??= mountKafkaTabOnce();
  return kafkaMount;
}

async function mountKafkaTabOnce(): Promise<void> {
  const host = document.getElementById("kafka-tab")!;
  kafkaTab?.dispose();
  kafkaTab = null;
  host.innerHTML = `<div class="code-loading">loading kafka…</div>`;
  try {
    // A variable specifier, as for code.js: kept a runtime import.
    const url = "/public/kafka.js";
    const mod = (await import(url)) as typeof import("./kafka.ts");
    kafkaTab = mod.mountKafkaTab(host, {
      client: kafkaAgent,
      isDark: () => isDark,
      notify,
      getKafkaAgent: () => kafkaAgentDownload?.open(),
      dismissNotices: () => notifier.dismissAll(),
    });
    kafkaTab.setTheme(isDark);
  } catch (e) {
    host.replaceChildren();
    const note = document.createElement("div");
    note.className = "code-loading";
    note.textContent = `could not load the kafka tab: ${e instanceof Error ? e.message : String(e)}`;
    host.appendChild(note);
    kafkaMount = null;
    return;
  }
  kafkaTab.focus();
}

// ── PWA: service worker + install prompt ──

/** Chromium's non-standard install event; absent everywhere else, which is why
 *  the install button is offered rather than always shown. */
interface InstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: string }>;
}

let installPrompt: InstallPromptEvent | null = null;

async function registerServiceWorker(): Promise<void> {
  // A service worker needs a secure context; over plain http on a remote host
  // registration throws, and the capability badge already explains why.
  if (!("serviceWorker" in navigator) || !window.isSecureContext) return;
  try {
    const reg = await navigator.serviceWorker.register("/sw.js", { scope: "/" });

    const offer = (worker: ServiceWorker | null): void => {
      // A worker reaching "installed" while another already controls the page
      // is an update, not a first install.
      if (!worker || !navigator.serviceWorker.controller) return;
      const bar = document.getElementById("update-bar")!;
      bar.hidden = false;
      document.getElementById("update-reload")!.onclick = () => {
        worker.postMessage("skip-waiting");
      };
      document.getElementById("update-dismiss")!.onclick = () => (bar.hidden = true);
    };

    if (reg.waiting) offer(reg.waiting);
    reg.addEventListener("updatefound", () => {
      const next = reg.installing;
      next?.addEventListener("statechange", () => {
        if (next.state === "installed") offer(next);
      });
    });

    // The new worker took over — reload once so the page matches its assets.
    let reloading = false;
    navigator.serviceWorker.addEventListener("controllerchange", () => {
      if (reloading) return;
      reloading = true;
      location.reload();
    });
  } catch {
    /* registration is best-effort; the app works without it */
  }
}

// ── Stats ──
function updateStats(tab: Tab, value = editors[tab].value): void {
  const ed = editors[tab];
  document.getElementById(`${tab}-lines`)!.textContent = String(ed.lineCount);
  document.getElementById(`${tab}-chars`)!.textContent = String(value.length);
  document.getElementById(`${tab}-bytes`)!.textContent = String(utf8Length(value));
  document.getElementById(`${tab}-sel`)!.textContent = String(ed.selectionLength());
}

// Recomputing stats reads the whole document and counts it, so it is debounced (with the lint
// badge) off the keystroke path to keep typing smooth on large inputs. A caret that only moved
// changes the selection count and nothing else, and says so without reading the text.
function updateSelection(tab: Tab): void {
  document.getElementById(`${tab}-sel`)!.textContent = String(editors[tab].selectionLength());
}

/** Tabs whose numbers are out of date because they changed while another tab was on screen. */
const statsStale = new Set<Tab>();
const statsTimers = {} as Record<Tab, ReturnType<typeof setTimeout>>;
function scheduleStats(tab: Tab): void {
  clearTimeout(statsTimers[tab]);
  statsTimers[tab] = setTimeout(() => flushStats(tab), 120);
}

/** The same, now. For a whole-buffer result the status line is part of the answer, and
 *  waiting out the debounce made it arrive 120 ms after the text it describes. */
function flushStats(tab: Tab): void {
  clearTimeout(statsTimers[tab]);
  // Nobody is looking at a tab that is not on screen: the numbers wait until it is.
  if (tab !== currentTab) {
    statsStale.add(tab);
    return;
  }
  // One read of the document, handed to both: the count and the badge's parse.
  const value = editors[tab].value;
  updateStats(tab, value);
  updateBadge(tab, value);
}

// ── Build per-tab DOM from the shared <template>, assigning the per-tab ids
// the rest of main.ts expects (e.g. ansible-editor, helm-password). Done here
// (not in an inline script) so it is guaranteed to run before editor creation. ──
function expandTabs(): void {
  const tpl = document.getElementById("tab-template") as HTMLTemplateElement;
  for (const host of document.querySelectorAll<HTMLElement>("[data-tabid]")) {
    const tab = host.dataset.tabid as Tab;
    const node = tpl.content.cloneNode(true) as DocumentFragment;
    node.querySelectorAll<HTMLElement>("[data-action]").forEach((b) => (b.dataset.tab = tab));
    const map: Record<string, string> = {
      "js-password": `${tab}-password`, "js-editor": `${tab}-editor`, "js-editor2": `${tab}-editor2`,
      "js-two": `${tab}-two-btn`,
      "js-badge": `${tab}-yaml-badge`, "js-beautify": `${tab}-beautify-btn`,
      "js-lnum": `${tab}-lnum-btn`, "js-ws": `${tab}-ws-btn`, "js-wrap": `${tab}-wrap-btn`, "js-fold": `${tab}-fold-btn`,
      "js-lines": `${tab}-lines`, "js-chars": `${tab}-chars`,
      "js-bytes": `${tab}-bytes`, "js-sel": `${tab}-sel`,
    };
    for (const [cls, id] of Object.entries(map)) {
      const el = node.querySelector("." + cls);
      if (el) el.id = id;
    }
    // Enter in the password field is a form submit: it encrypts, and goes nowhere else.
    node.querySelector(".js-pw-form")?.addEventListener("submit", (e) => {
      e.preventDefault();
      void cryptoAction(tab, "encrypt");
    });
    host.appendChild(node);
  }
}

// ── Init ──
function init(): void {
  expandTabs();
  for (const tab of ["ansible", "helm"] as Tab[]) {
    const mount = document.getElementById(`${tab}-editor`)!;
    const placeholder =
      tab === "ansible"
        ? "Paste plaintext to encrypt, or $ANSIBLE_VAULT;1.1;AES256 ciphertext to decrypt…"
        : "Paste plaintext to encrypt, or helm ciphertext to decrypt…";
    const ed = new TabEditor(tab, mount, placeholder);
    editors[tab] = ed;
    ed.onChange((docChanged) => (docChanged ? scheduleStats(tab) : updateSelection(tab)));
    // reflect persisted view-toggle state on the buttons
    (["lineNumbers", "whitespace", "wrap", "fold"] as (keyof ViewPrefs)[]).forEach((k) => {
      const id = { lineNumbers: "lnum", whitespace: "ws", wrap: "wrap", fold: "fold" }[k];
      document.getElementById(`${tab}-${id}-btn`)?.classList.toggle("is-active", ed.isOn(k));
    });
    updateStats(tab);
  }

  applyTheme(prefersDark(), false);
  // No choice written down yet: the desktop stays in charge for as long as that
  // is true, so switching the system theme moves an open tab with it.
  watchSystemTheme((dark) => applyTheme(dark, false));

  // Chromium fires this instead of showing its own install affordance; hold on
  // to it so the capability popover can offer installation at a sensible moment.
  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault();
    installPrompt = e as InstallPromptEvent;
    refreshBadge?.();
  });
  window.addEventListener("appinstalled", () => {
    installPrompt = null;
    refreshBadge?.();
  });

  codeAgentDownload = mountCodeAgentDownload(document.getElementById("code-agent-dl")!);
  kafkaAgentDownload = mountKafkaAgentDownload(document.getElementById("kafka-agent-dl")!);

  // The kafka-agent's status, beside the kafka tab and shown only there — as the
  // code-agent's is beside the code tab.
  refreshKafkaBadge = mountKafkaBadge(document.getElementById("kafka-badge")!, kafkaAgent, async () => {
    // One call, as for the code badge: switchTab opens the tab, and the await
    // is the mount it started rather than a second request for one.
    await switchTab("kafka");
    // The same dialog the card's button opens, as the code badge does for its tab.
    void kafkaTab?.promptConnect();
  });
  refreshKafkaBadge();

  // The badge reports on the local code-agent, so it sits with the code tab's tools
  // rather than in the header's right-hand group.
  refreshBadge = mountBadge(
    document.getElementById("cap-badge")!,
    codeAgent,
    async () => {
      // switchTab opens the tab, and waiting on it is waiting on that same
      // mount — the badge used to ask for the tab a second time, which is what
      // mounted the editor twice.
      await switchTab("code");
      await codeTab?.connect();
    },
    {
      canInstall: () => installPrompt !== null,
      install: async () => {
        const prompt = installPrompt;
        if (!prompt) return;
        installPrompt = null; // a prompt may only be used once
        await prompt.prompt();
        await prompt.userChoice.catch(() => undefined);
        refreshBadge?.();
      },
    },
  );
  refreshBadge();
  void registerServiceWorker();

  // Reconnect to the code-agent the user last used. Failure is silent — the badge
  // already reports it, and a crypto-only visitor should see no error.
  const saved = codeAgent.autoConnectUrl();
  if (saved) void codeAgent.connect(saved).catch(() => undefined);
  const savedKafka = kafkaAgent.autoConnectUrl();
  if (savedKafka) void kafkaAgent.connect(savedKafka).catch(() => undefined);

  // Bind data-action buttons declaratively (index.html uses data-* attrs, no inline JS).
  document.querySelectorAll<HTMLElement>("[data-action]").forEach((el) => {
    el.addEventListener("click", () => {
      const target = (el.dataset.tab as AnyTab) || currentTab;
      const action = el.dataset.action;
      if (action === "switch") return switchTab(target);
      if (action === "theme") return applyTheme(!isDark);
      // Everything below operates on a crypto editor, which the code and kafka
      // tabs have none of.
      if (!isCryptoTab(target)) return;
      const tab: Tab = target;
      switch (action) {
        case "encrypt": case "decrypt": cryptoAction(tab, action); break;
        case "b64encode": void b64Encode(tab, el, false); break;
        case "b64unix": void b64Encode(tab, el, true); break;
        case "b64decode": void b64Decode(tab, el); break;
        case "load": loadFile(tab); break;
        case "save": saveFile(tab); break;
        case "copy": copyText(tab); break;
        case "clear": clearText(tab); break;
        case "lint": toggleLint(tab, el); break;
        case "beautify": void yamlBeautify(tab, el); break;
        case "lnum": toggleView(tab, "lineNumbers", `${tab}-lnum-btn`); break;
        case "ws": toggleView(tab, "whitespace", `${tab}-ws-btn`); break;
        case "wrap": toggleView(tab, "wrap", `${tab}-wrap-btn`); break;
        case "fold": toggleView(tab, "fold", `${tab}-fold-btn`); break;
        case "find": case "replace": editors[tab].openFind(); break;
        case "two": toggleTwoPane(tab, el); break;
        case "togglePw": {
          const inp = document.getElementById(`${tab}-password`) as HTMLInputElement;
          inp.type = inp.type === "password" ? "text" : "password";
          break;
        }
      }
    });
  });

  // The two operations this tab exists for had no keyboard at all: you typed a
  // password, then reached for the mouse. Captured, because CodeMirror's own
  // keymap would otherwise take Ctrl+D (select-next-occurrence) first.
  document.addEventListener(
    "keydown",
    (e) => {
      const tab = currentTab;
      if (!isCryptoTab(tab) || !(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey) return;
      const action = e.code === "KeyE" ? "encrypt" : e.code === "KeyD" ? "decrypt" : null;
      if (!action) return;
      e.preventDefault();
      e.stopPropagation();
      void cryptoAction(tab, action);
    },
    true,
  );
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init);
} else {
  init();
}
