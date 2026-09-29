/** Capability detection and the status badge.
 *
 *  The useful distinction is not "browser tab vs installed PWA" — those run the
 *  same code with nearly identical powers. What actually decides whether the
 *  code tab works is: is the code-agent reachable, does this engine allow a loopback
 *  socket from an https page, and is git installed. The badge reports exactly
 *  that, and every control that needs a capability carries `data-requires`.
 */
import type { CodeAgentClient } from "./code-agent.ts";
import { VERSION } from "../../version.ts";
import { esc } from "./ui.ts";

export interface Caps {
  /** https:// or localhost — required for service workers. */
  secure: boolean;
  serviceWorker: boolean;
  /** Launched from the home screen / installed window rather than a tab. */
  installed: boolean;
  /** WebKit blocks ws://127.0.0.1 from an https page, so the code tab cannot
   *  reach a code-agent there at all. Reported up front instead of as a timeout. */
  loopbackBlocked: boolean;
  codeAgent: boolean;
  /** The connected code-agent matches this build. Users download the code-agent once and
   *  keep it, so the two drift apart on their own; without this the mismatch
   *  would surface later as an unexplained "unknown op". True while offline,
   *  where there is nothing to compare. */
  codeAgentCurrent: boolean;
  git: boolean;
  ripgrep: boolean;
  watch: boolean;
}

/** Safari/WebKit, excluding the Chromium and Gecko engines that also claim
 *  "Safari" in their UA string. */
function isWebKit(): boolean {
  const ua = navigator.userAgent;
  return /AppleWebKit/.test(ua) && !/Chrome|Chromium|Edg|OPR|Firefox/.test(ua);
}

export function detect(codeAgent: CodeAgentClient): Caps {
  const info = codeAgent.info;
  return {
    secure: window.isSecureContext,
    serviceWorker: "serviceWorker" in navigator,
    installed: window.matchMedia?.("(display-mode: standalone)").matches ?? false,
    loopbackBlocked: isWebKit() && window.location.protocol === "https:",
    codeAgent: codeAgent.state === "online",
    codeAgentCurrent: codeAgent.state !== "online" || info?.version === VERSION,
    git: Boolean(info?.gitVersion),
    ripgrep: Boolean(info?.ripgrep),
    watch: Boolean(info?.watch),
  };
}

interface Row {
  key: keyof Caps;
  label: string;
  /** Shown when the capability is missing: what is lost and how to get it. A
   *  function when the useful text depends on what the code-agent reported. */
  fix: string | ((codeAgent: CodeAgentClient) => string);
  /** Rows that only mean something while a code-agent is connected. */
  needsCodeAgent?: boolean;
}

const ROWS: Row[] = [
  { key: "codeAgent", label: "local code-agent", fix: "Run `enc-tool code-agent` in your project folder, then paste its URL here." },
  {
    key: "codeAgentCurrent",
    label: "code-agent up to date",
    needsCodeAgent: true,
    fix: (codeAgent) =>
      `The code-agent is ${codeAgent.info?.version ?? "an unknown version"}, this app is ${VERSION}. Download the current one from "get code-agent" on the code tab.`,
  },
  // These three are properties of the machine the code-agent runs on, so with no
  // code-agent connected the honest answer is "we have not asked yet" — not "✗".
  // The badge used to tell people to install git on a machine that had it and
  // declare file watching unavailable on a platform that supports it, purely
  // because a socket was down.
  {
    key: "git",
    label: "git",
    needsCodeAgent: true,
    // "Install git" is the wrong advice for a machine that has one: the code-agent
    // says when it is there but too old to use, and that is what to show.
    fix: (codeAgent) => codeAgent.info?.gitProblem ?? "Install git and restart the code-agent — version control is unavailable without it.",
  },
  { key: "ripgrep", label: "ripgrep", needsCodeAgent: true, fix: "Optional. Without it project search uses a slower built-in scan." },
  { key: "watch", label: "live file watching", needsCodeAgent: true, fix: "Unavailable on this platform — refresh the tree manually after external changes." },
  { key: "secure", label: "secure context", fix: "Serve the app over HTTPS; without it the service worker cannot install." },
  { key: "installed", label: "installed as an app", fix: "Optional. Install from the browser menu for a standalone window." },
];

export const HINTS: Record<string, string> = {
  codeAgent: "Requires the local code-agent",
  git: "Requires git on the code-agent machine",
};

/** Disable and mark every control whose capability is missing. Controls opt in
 *  with `data-requires="codeAgent"`, so this stays a single pass over the DOM. */
export function applyRequirements(root: ParentNode, caps: Caps): void {
  for (const el of root.querySelectorAll<HTMLElement>("[data-requires]")) {
    const need = el.dataset.requires as keyof Caps;
    const has = Boolean(caps[need]);
    // The control's own tooltip, remembered the first time it is seen and put
    // back when the capability arrives.
    //
    // It used to be cleared instead — `el.title = ""` — which meant that
    // connecting a code-agent silently stripped the labels off exactly the controls
    // that have nothing but an icon: search, source control, history, reload.
    // They are unlabelled only after everything starts working, which is why
    // this was easy to miss and maddening to use.
    if (el.dataset.capTitle === undefined && !el.title.startsWith("Requires")) el.dataset.capTitle = el.title;
    el.classList.toggle("needs-cap", !has);
    if (el instanceof HTMLButtonElement || el instanceof HTMLInputElement) el.disabled = !has;
    el.title = has ? (el.dataset.capTitle ?? "") : (HINTS[need] ?? `Requires: ${need}`);
  }
}

export interface PwaHooks {
  /** True only in browsers that offered an install prompt we captured. */
  canInstall(): boolean;
  install(): void;
}

/** Render the header chip plus its popover. Returns an update function so the
 *  caller can refresh it whenever the code-agent's state changes. */
export function mountBadge(host: HTMLElement, codeAgent: CodeAgentClient, onConnect: () => void, pwa?: PwaHooks): () => void {
  host.className = "cap-badge";
  host.innerHTML = `
    <button class="cap-chip" type="button" aria-haspopup="dialog" aria-expanded="false">
      <span class="cap-dot"></span><span class="cap-text">code-agent</span>
    </button>
    <div class="cap-pop" hidden></div>`;

  const chip = host.querySelector<HTMLButtonElement>(".cap-chip")!;
  const dot = host.querySelector<HTMLElement>(".cap-dot")!;
  const text = host.querySelector<HTMLElement>(".cap-text")!;
  const pop = host.querySelector<HTMLElement>(".cap-pop")!;

  chip.addEventListener("click", () => {
    const show = pop.hidden;
    pop.hidden = !show;
    chip.setAttribute("aria-expanded", String(show));
  });
  document.addEventListener("click", (e) => {
    if (!host.contains(e.target as Node)) {
      pop.hidden = true;
      chip.setAttribute("aria-expanded", "false");
    }
  });

  return function update(): void {
    const caps = detect(codeAgent);
    const status = caps.loopbackBlocked
      ? "blocked"
      : codeAgent.state === "online"
        ? "online"
        : codeAgent.state === "connecting"
          ? "connecting"
          : codeAgent.state === "error"
            ? "error"
            : "offline";

    host.dataset.status = status;
    dot.textContent = { online: "●", connecting: "◐", error: "✕", offline: "◌", blocked: "✕" }[status];
    text.textContent = status === "online" ? (codeAgent.info?.root.split(/[/\\]/).pop() ?? "code-agent") : "code-agent";
    chip.title =
      status === "online"
        ? `Connected — ${codeAgent.info?.root}`
        : status === "blocked"
          ? "This browser blocks loopback connections from an https page"
          : codeAgent.lastError || "Code-agent not connected";

    pop.innerHTML = `
      <div class="cap-head">${esc(headline(status, codeAgent.lastError))}</div>
      <ul class="cap-list">${ROWS.map((r) => row(r, caps, codeAgent, !r.needsCodeAgent || caps.codeAgent)).join("")}</ul>
      ${status === "online" ? "" : `<button class="t-btn cap-connect" type="button">connect to code-agent…</button>`}
      ${pwa?.canInstall() ? `<button class="t-btn cap-install" type="button">install as an app</button>` : ""}`;

    pop.querySelector<HTMLButtonElement>(".cap-connect")?.addEventListener("click", () => {
      pop.hidden = true;
      onConnect();
    });
    pop.querySelector<HTMLButtonElement>(".cap-install")?.addEventListener("click", () => {
      pop.hidden = true;
      pwa?.install();
    });

    applyRequirements(document, caps);
  };
}

function headline(status: string, error: string): string {
  switch (status) {
    case "online": return "All local features available";
    case "connecting": return "Connecting to the code-agent…";
    case "blocked": return "This browser cannot reach a local code-agent";
    case "error": return error || "Code-agent connection failed";
    default: return "Editing and git need the local code-agent";
  }
}

function row(r: Row, caps: Caps, codeAgent: CodeAgentClient, known: boolean): string {
  // Three states, not two. "?" is not a failure and carries no advice — there
  // is nothing to advise about a machine nobody has spoken to.
  if (!known) {
    return `<li class="unknown">
      <span class="cap-mark">?</span>
      <span class="cap-label">${esc(r.label)}</span>
      <span class="cap-fix">Unknown until a code-agent is connected.</span>
    </li>`;
  }
  const on = Boolean(caps[r.key]);
  const fix = typeof r.fix === "function" ? r.fix(codeAgent) : r.fix;
  return `<li class="${on ? "on" : "off"}">
    <span class="cap-mark">${on ? "✓" : "✗"}</span>
    <span class="cap-label">${esc(r.label)}</span>
    ${on ? "" : `<span class="cap-fix">${esc(fix)}</span>`}
  </li>`;
}

