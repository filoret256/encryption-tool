/** Capability detection and the status badge.
 *
 *  The useful distinction is not "browser tab vs installed PWA" — those run the
 *  same code with nearly identical powers. What actually decides whether the
 *  code tab works is: is the agent reachable, does this engine allow a loopback
 *  socket from an https page, and is git installed. The badge reports exactly
 *  that, and every control that needs a capability carries `data-requires`.
 */
import type { AgentClient } from "./agent.ts";
import { VERSION } from "../../version.ts";

export interface Caps {
  /** https:// or localhost — required for service workers. */
  secure: boolean;
  serviceWorker: boolean;
  /** Launched from the home screen / installed window rather than a tab. */
  installed: boolean;
  /** WebKit blocks ws://127.0.0.1 from an https page, so the code tab cannot
   *  reach an agent there at all. Reported up front instead of as a timeout. */
  loopbackBlocked: boolean;
  agent: boolean;
  /** The connected agent matches this build. Users download the agent once and
   *  keep it, so the two drift apart on their own; without this the mismatch
   *  would surface later as an unexplained "unknown op". True while offline,
   *  where there is nothing to compare. */
  agentCurrent: boolean;
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

export function detect(agent: AgentClient): Caps {
  const info = agent.info;
  return {
    secure: window.isSecureContext,
    serviceWorker: "serviceWorker" in navigator,
    installed: window.matchMedia?.("(display-mode: standalone)").matches ?? false,
    loopbackBlocked: isWebKit() && window.location.protocol === "https:",
    agent: agent.state === "online",
    agentCurrent: agent.state !== "online" || info?.version === VERSION,
    git: Boolean(info?.gitVersion),
    ripgrep: Boolean(info?.ripgrep),
    watch: Boolean(info?.watch),
  };
}

interface Row {
  key: keyof Caps;
  label: string;
  /** Shown when the capability is missing: what is lost and how to get it. A
   *  function when the useful text depends on what the agent reported. */
  fix: string | ((agent: AgentClient) => string);
  /** Rows that only mean something while an agent is connected. */
  needsAgent?: boolean;
}

const ROWS: Row[] = [
  { key: "agent", label: "local agent", fix: "Run `enc-tool agent` in your project folder, then paste its URL here." },
  {
    key: "agentCurrent",
    label: "agent up to date",
    needsAgent: true,
    fix: (agent) =>
      `The agent is ${agent.info?.version ?? "an unknown version"}, this app is ${VERSION}. Download the current one from "get agent" on the code tab.`,
  },
  { key: "git", label: "git", fix: "Install git and restart the agent — version control is unavailable without it." },
  { key: "ripgrep", label: "ripgrep", fix: "Optional. Without it project search uses a slower built-in scan." },
  { key: "watch", label: "live file watching", fix: "Unavailable on this platform — refresh the tree manually after external changes." },
  { key: "secure", label: "secure context", fix: "Serve the app over HTTPS; without it the service worker cannot install." },
  { key: "installed", label: "installed as an app", fix: "Optional. Install from the browser menu for a standalone window." },
];

export const HINTS: Record<string, string> = {
  agent: "Requires the local agent",
  git: "Requires git on the agent machine",
};

/** Disable and mark every control whose capability is missing. Controls opt in
 *  with `data-requires="agent"`, so this stays a single pass over the DOM. */
export function applyRequirements(root: ParentNode, caps: Caps): void {
  for (const el of root.querySelectorAll<HTMLElement>("[data-requires]")) {
    const need = el.dataset.requires as keyof Caps;
    const has = Boolean(caps[need]);
    el.classList.toggle("needs-cap", !has);
    if (el instanceof HTMLButtonElement || el instanceof HTMLInputElement) el.disabled = !has;
    if (!has) el.title = HINTS[need] ?? `Requires: ${need}`;
    else if (el.title.startsWith("Requires")) el.title = "";
  }
}

export interface PwaHooks {
  /** True only in browsers that offered an install prompt we captured. */
  canInstall(): boolean;
  install(): void;
}

/** Render the header chip plus its popover. Returns an update function so the
 *  caller can refresh it whenever the agent's state changes. */
export function mountBadge(host: HTMLElement, agent: AgentClient, onConnect: () => void, pwa?: PwaHooks): () => void {
  host.className = "cap-badge";
  host.innerHTML = `
    <button class="cap-chip" type="button" aria-haspopup="dialog" aria-expanded="false">
      <span class="cap-dot"></span><span class="cap-text">agent</span>
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
    const caps = detect(agent);
    const status = caps.loopbackBlocked
      ? "blocked"
      : agent.state === "online"
        ? "online"
        : agent.state === "connecting"
          ? "connecting"
          : agent.state === "error"
            ? "error"
            : "offline";

    host.dataset.status = status;
    dot.textContent = { online: "●", connecting: "◐", error: "✕", offline: "◌", blocked: "✕" }[status];
    text.textContent = status === "online" ? (agent.info?.root.split(/[/\\]/).pop() ?? "agent") : "agent";
    chip.title =
      status === "online"
        ? `Connected — ${agent.info?.root}`
        : status === "blocked"
          ? "This browser blocks loopback connections from an https page"
          : agent.lastError || "Agent not connected";

    pop.innerHTML = `
      <div class="cap-head">${escapeHtml(headline(status, agent.lastError))}</div>
      <ul class="cap-list">${ROWS.filter((r) => !r.needsAgent || caps.agent)
        .map((r) => row(r, caps, agent))
        .join("")}</ul>
      ${status === "online" ? "" : `<button class="t-btn cap-connect" type="button">connect to agent…</button>`}
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
    case "connecting": return "Connecting to the agent…";
    case "blocked": return "This browser cannot reach a local agent";
    case "error": return error || "Agent connection failed";
    default: return "Editing and git need the local agent";
  }
}

function row(r: Row, caps: Caps, agent: AgentClient): string {
  const on = Boolean(caps[r.key]);
  const fix = typeof r.fix === "function" ? r.fix(agent) : r.fix;
  return `<li class="${on ? "on" : "off"}">
    <span class="cap-mark">${on ? "✓" : "✗"}</span>
    <span class="cap-label">${escapeHtml(r.label)}</span>
    ${on ? "" : `<span class="cap-fix">${escapeHtml(fix)}</span>`}
  </li>`;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
}
