/** Toolbar wiring for the CodeMirror-based UI. Replaces the ~1,250 lines of inline JS. */
import "./style.css";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { TabEditor, type Tab, type ViewPrefs } from "./editor.ts";
import { yamlDiagnostics } from "./yaml-lint.ts";
import { ansible, helm } from "../crypto/index.ts";
import { AgentClient } from "./code/agent.ts";
import { mountBadge } from "./code/caps.ts";
import { mountAgentDownload, type AgentDownload } from "./code/download.ts";
import type { CodeTab } from "./code.ts";

/** The code tab is not a crypto tab — it has its own layout and no editor in
 *  `editors`, so anything indexing by Tab must exclude it. */
type AnyTab = Tab | "code";
const TABS: AnyTab[] = ["ansible", "helm", "code"];

const editors = {} as Record<Tab, TabEditor>;
let currentTab: AnyTab = "ansible";
let isDark = false;

// The agent client lives in the main bundle so the capability badge is correct
// from first paint, before the code chunk is ever fetched.
const agent = new AgentClient(() => onAgentState());
let codeTab: CodeTab | null = null;
let refreshBadge: (() => void) | null = null;
let agentDownload: AgentDownload | null = null;

// ── Toast ──
function toast(msg: string, isError = false): void {
  const el = document.getElementById("toast")!;
  el.textContent = msg;
  el.className = "toast show" + (isError ? " error" : "");
  setTimeout(() => (el.className = "toast"), 2200);
}

// ── Crypto ──
// Runs here on WebCrypto rather than over the /helm/* and /ansible/* endpoints.
// Two reasons: the password never leaves this machine, and the crypto tabs keep
// working with no network at all, which is what makes the installed app
// genuinely offline. The endpoints stay for API clients.
const SCHEMES: Record<Tab, { encrypt(text: string, password: string): Promise<string>; decrypt(text: string, password: string): Promise<string> }> = {
  ansible,
  helm,
};

function pw(tab: Tab): string {
  return (document.getElementById(`${tab}-password`) as HTMLInputElement).value;
}

async function cryptoAction(tab: Tab, action: "encrypt" | "decrypt"): Promise<void> {
  const password = pw(tab);
  const text = editors[tab].value;
  if (!text.trim()) return toast("Text is required", true);
  if (!password) return toast("Password is required", true);
  try {
    editors[tab].value = await SCHEMES[tab][action](text, password);
    toast(`${action}ed`);
  } catch (e) {
    toast(e instanceof Error ? e.message : String(e), true);
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

function updateBadge(tab: Tab): void {
  const badge = document.getElementById(`${tab}-yaml-badge`)!;
  if (!lintOn[tab]) {
    badge.textContent = "";
    badge.className = "yaml-badge";
    return;
  }
  const errors = yamlDiagnostics(editors[tab].value);
  badge.textContent = errors.length ? `✗ ${errors.length}` : "✓ valid";
  badge.className = "yaml-badge " + (errors.length ? "bad" : "ok");
}

function yamlBeautify(tab: Tab): void {
  try {
    editors[tab].value = stringifyYaml(parseYaml(editors[tab].value), { indent: 2 });
    toast("beautified");
  } catch (e) {
    toast("YAML beautify failed: " + (e instanceof Error ? e.message : String(e)), true);
  }
}

// ── Base64 ──
// Convert bytes -> binary string in chunks. Spreading a large Uint8Array into
// String.fromCharCode(...) overflows the call stack (and is slow) on big inputs.
function bytesToBinary(bytes: Uint8Array): string {
  const CHUNK = 0x8000;
  let out = "";
  for (let i = 0; i < bytes.length; i += CHUNK) {
    out += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return out;
}

function b64Encode(tab: Tab, unix: boolean): void {
  try {
    let text = editors[tab].value;
    if (unix) text = text.replace(/\r\n/g, "\n");
    editors[tab].value = btoa(bytesToBinary(new TextEncoder().encode(text)));
  } catch {
    toast("Base64 encode failed", true);
  }
}

function b64Decode(tab: Tab): void {
  try {
    const bin = atob(editors[tab].value.replace(/\s/g, ""));
    editors[tab].value = new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
  } catch {
    toast("Base64 decode failed", true);
  }
}

// ── File IO ──
function loadFile(tab: Tab): void {
  const input = document.getElementById("file-input") as HTMLInputElement;
  input.onchange = () => {
    const file = input.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      editors[tab].value = String(reader.result);
      toast(`loaded ${file.name}`);
    };
    reader.readAsText(file);
    input.value = "";
  };
  input.click();
}

function saveFile(tab: Tab): void {
  const blob = new Blob([editors[tab].value], { type: "text/plain" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `${tab}-output.txt`;
  a.click();
  URL.revokeObjectURL(a.href);
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
function applyTheme(dark: boolean): void {
  isDark = dark;
  // The toggle visuals (track colour + knob slide) are driven by this attribute.
  document.documentElement.setAttribute("data-theme", dark ? "dark" : "light");
  Object.values(editors).forEach((e) => e.setTheme(dark));
  codeTab?.setTheme(dark);
  try {
    localStorage.setItem("enc-theme", dark ? "dark" : "light");
  } catch {
    /* ignore */
  }
}

// ── Tabs ──
function switchTab(tab: AnyTab): void {
  currentTab = tab;
  for (const t of TABS) {
    document.getElementById(`${t}-tab`)!.classList.toggle("active", t === tab);
    document.querySelector(`.tab-${t}`)!.classList.toggle("active", t === tab);
  }
  // Nothing but the editor needs a local agent, so the download only appears
  // where it means something.
  agentDownload?.setVisible(tab === "code");
  if (tab === "code") {
    void openCodeTab();
    return;
  }
  editors[tab].refresh();
  editors[tab].focus();
}

// ── Code tab (lazily loaded chunk) ──
function onAgentState(): void {
  refreshBadge?.();
  codeTab?.onAgentState();
}

async function openCodeTab(): Promise<void> {
  const host = document.getElementById("code-tab")!;
  if (!codeTab) {
    host.innerHTML = `<div class="code-loading">loading editor…</div>`;
    try {
      // The specifier is a variable so the bundler leaves it as a runtime
      // import instead of inlining the chunk back into main.js.
      const url = "/public/code.js";
      const mod = (await import(url)) as typeof import("./code.ts");
      codeTab = mod.mountCodeTab(host, {
        agent,
        isDark: () => isDark,
        toast,
        onCapsChanged: () => refreshBadge?.(),
      });
      codeTab.setTheme(isDark);
    } catch (e) {
      host.innerHTML = `<div class="code-loading">could not load the editor: ${e instanceof Error ? e.message : String(e)}</div>`;
      return;
    }
  }
  codeTab.focus();
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
function updateStats(tab: Tab): void {
  const ed = editors[tab];
  const value = ed.value;
  document.getElementById(`${tab}-lines`)!.textContent = String(ed.lineCount);
  document.getElementById(`${tab}-chars`)!.textContent = String(value.length);
  document.getElementById(`${tab}-bytes`)!.textContent = String(new TextEncoder().encode(value).length);
  document.getElementById(`${tab}-sel`)!.textContent = String(ed.selectionLength());
}

// Recomputing stats scans the whole document (getValue + TextEncoder), so debounce
// it (and the lint badge) off the keystroke path to keep typing smooth on large inputs.
const statsTimers = {} as Record<Tab, ReturnType<typeof setTimeout>>;
function scheduleStats(tab: Tab): void {
  clearTimeout(statsTimers[tab]);
  statsTimers[tab] = setTimeout(() => {
    updateStats(tab);
    updateBadge(tab);
  }, 120);
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
      "js-password": `${tab}-password`, "js-editor": `${tab}-editor`,
      "js-badge": `${tab}-yaml-badge`, "js-beautify": `${tab}-beautify-btn`,
      "js-lnum": `${tab}-lnum-btn`, "js-ws": `${tab}-ws-btn`, "js-wrap": `${tab}-wrap-btn`,
      "js-lines": `${tab}-lines`, "js-chars": `${tab}-chars`,
      "js-bytes": `${tab}-bytes`, "js-sel": `${tab}-sel`,
    };
    for (const [cls, id] of Object.entries(map)) {
      const el = node.querySelector("." + cls);
      if (el) el.id = id;
    }
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
    ed.onChange(() => scheduleStats(tab));
    // reflect persisted view-toggle state on the buttons
    (["lineNumbers", "whitespace", "wrap"] as (keyof ViewPrefs)[]).forEach((k) => {
      const id = { lineNumbers: "lnum", whitespace: "ws", wrap: "wrap" }[k];
      document.getElementById(`${tab}-${id}-btn`)?.classList.toggle("is-active", ed.isOn(k));
    });
    updateStats(tab);
  }

  applyTheme(localStorage.getItem("enc-theme") === "dark");

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

  agentDownload = mountAgentDownload(document.getElementById("agent-dl")!);

  // Capability badge lives in the header so it is visible from every tab.
  refreshBadge = mountBadge(
    document.getElementById("cap-badge")!,
    agent,
    async () => {
      switchTab("code");
      await openCodeTab();
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

  // Reconnect to the agent the user last used. Failure is silent — the badge
  // already reports it, and a crypto-only visitor should see no error.
  const saved = agent.savedUrl();
  if (saved) void agent.connect(saved).catch(() => undefined);

  // Bind data-action buttons declaratively (index.html uses data-* attrs, no inline JS).
  document.querySelectorAll<HTMLElement>("[data-action]").forEach((el) => {
    el.addEventListener("click", () => {
      const target = (el.dataset.tab as AnyTab) || currentTab;
      const action = el.dataset.action;
      if (action === "switch") return switchTab(target);
      if (action === "theme") return applyTheme(!isDark);
      // Everything below operates on a crypto editor, which the code tab has none of.
      if (target === "code") return;
      const tab: Tab = target;
      switch (action) {
        case "encrypt": case "decrypt": cryptoAction(tab, action); break;
        case "b64encode": b64Encode(tab, false); break;
        case "b64unix": b64Encode(tab, true); break;
        case "b64decode": b64Decode(tab); break;
        case "load": loadFile(tab); break;
        case "save": saveFile(tab); break;
        case "copy": copyText(tab); break;
        case "clear": clearText(tab); break;
        case "lint": toggleLint(tab, el); break;
        case "beautify": yamlBeautify(tab); break;
        case "lnum": toggleView(tab, "lineNumbers", `${tab}-lnum-btn`); break;
        case "ws": toggleView(tab, "whitespace", `${tab}-ws-btn`); break;
        case "wrap": toggleView(tab, "wrap", `${tab}-wrap-btn`); break;
        case "find": case "replace": editors[tab].openFind(); break;
        case "togglePw": {
          const inp = document.getElementById(`${tab}-password`) as HTMLInputElement;
          inp.type = inp.type === "password" ? "text" : "password";
          break;
        }
      }
    });
  });
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init);
} else {
  init();
}
