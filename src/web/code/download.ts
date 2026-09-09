/** "Get the agent" panel.
 *
 *  The code tab is the only part of the app that needs a process on the user's
 *  own machine, and the app itself usually runs in a container where no such
 *  process can exist. So the deployment ships cross-compiled agents and this
 *  panel hands the right one over: the archive for the detected platform, the
 *  exact command to run it against *this* origin, and the checksum — the agent
 *  gets filesystem access, so being able to verify what you downloaded is not
 *  a nicety.
 *
 *  Mounted in the header but revealed only on the code tab; the manifest is
 *  fetched the first time it is revealed, so the crypto tabs never ask for it.
 */
import { esc } from "./ui.ts";

interface Build {
  id: string;
  os: "windows" | "macos" | "linux";
  arch: "x64" | "arm64";
  label: string;
  exe: string;
  kind: "zip" | "tar.gz";
  file: string;
  url: string;
  size?: number;
  sha256?: string;
}

interface Manifest {
  version: string;
  builds: Build[];
}

/** Chromium's client hints; absent in Firefox and Safari, hence the UA fallback. */
interface UAData {
  platform: string;
  getHighEntropyValues?(hints: string[]): Promise<{ architecture?: string; bitness?: string }>;
}

/** Best guess at the visitor's platform, as a target id. Only a default — every
 *  other build stays one click away, because this cannot be made reliable:
 *  Firefox and Safari expose no architecture at all. */
async function guessTarget(): Promise<string> {
  const uaData = (navigator as Navigator & { userAgentData?: UAData }).userAgentData;
  if (uaData?.getHighEntropyValues) {
    try {
      const hints = await uaData.getHighEntropyValues(["architecture", "bitness"]);
      const arm = hints.architecture === "arm";
      switch (uaData.platform) {
        case "Windows": return "windows-x64";
        case "macOS": return arm ? "darwin-arm64" : "darwin-x64";
        case "Linux": return arm ? "linux-arm64" : "linux-x64";
      }
    } catch {
      /* the promise rejects when the permission policy forbids the hint */
    }
  }
  const ua = navigator.userAgent;
  if (/Windows/.test(ua)) return "windows-x64";
  // Apple Silicon is invisible to the UA string, and it is now the common Mac.
  if (/Mac OS X|Macintosh/.test(ua)) return "darwin-arm64";
  if (/aarch64|arm64/i.test(ua)) return "linux-arm64";
  return "linux-x64";
}

const mb = (n: number): string => `${(n / 1048576).toFixed(0)} MB`;

/** The two lines that get someone from a downloaded archive to a running agent,
 *  with this page's origin already filled in.
 *
 *  The project folder is passed as an argument rather than reached with `cd`,
 *  so one downloaded binary serves every repository instead of being copied
 *  into each. Forward slashes throughout: PowerShell accepts them too, so one
 *  shape of path works on all three platforms. */
function commands(b: Build, origin: string): string {
  // Loopback origins are allowed unconditionally by the agent, so the flag
  // would be noise when the app is served from localhost.
  const local = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:|$)/.test(origin);
  const allow = local ? "" : ` --allow-origin ${origin}`;
  const folder = b.os === "windows" ? "C:/path/to/your/project" : "~/path/to/your/project";
  const unpack =
    b.os === "windows"
      ? `cd ~/Downloads; Expand-Archive ./${b.file} -DestinationPath . -Force`
      : `cd ~/Downloads && tar -xzf ${b.file}`;
  return [unpack, `./${b.exe} ${folder}${allow}`].join("\n");
}

/** Platform-specific friction, stated before it is met rather than after. */
function caveat(b: Build): string {
  switch (b.os) {
    case "macos":
      return "Unpacking with <code>tar</code> in Terminal keeps macOS from quarantining the binary. Extract it in Finder instead and you will need <code>xattr -d com.apple.quarantine ./enc-tool-agent</code> first.";
    case "windows":
      return "The binary is unsigned, so SmartScreen may warn on first run. Starting it from a terminal, as above, avoids the prompt.";
    default:
      return "The archive carries the executable bit, so no <code>chmod</code> is needed.";
  }
}

export interface AgentDownload {
  /** Called on every tab switch; the manifest is fetched on the first reveal. */
  setVisible(visible: boolean): void;
}

export function mountAgentDownload(host: HTMLElement): AgentDownload {
  host.className = "agent-dl";
  host.hidden = true;
  host.innerHTML = `
    <button class="agent-dl-chip" type="button" aria-haspopup="dialog" aria-expanded="false"
            title="Download the local agent for your machine">⤓ get agent</button>
    <div class="agent-dl-pop" hidden></div>`;

  const chip = host.querySelector<HTMLButtonElement>(".agent-dl-chip")!;
  const pop = host.querySelector<HTMLElement>(".agent-dl-pop")!;

  let manifest: Manifest | null = null;
  let loading: Promise<void> | null = null;
  let selected = "";
  let wanted = false;

  const close = (): void => {
    pop.hidden = true;
    chip.setAttribute("aria-expanded", "false");
  };

  chip.addEventListener("click", () => {
    const show = pop.hidden;
    pop.hidden = !show;
    chip.setAttribute("aria-expanded", String(show));
    if (show) render();
  });
  // Capture phase, deliberately: picking another platform re-renders the
  // popover from its own click handler, and by the time a bubbling listener ran
  // the clicked button would already be detached — `host.contains` would say
  // "outside" and close the panel the user just used.
  document.addEventListener(
    "click",
    (e) => {
      if (!host.contains(e.target as Node)) close();
    },
    true,
  );
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") close();
  });

  function load(): Promise<void> {
    return (loading ??= (async () => {
      try {
        const res = await fetch("/agent/downloads");
        if (!res.ok) throw new Error(String(res.status));
        manifest = (await res.json()) as Manifest;
      } catch {
        // An older server, or none reachable: offering nothing beats offering
        // a dead link. The capability badge still explains what is missing.
        manifest = { version: "", builds: [] };
      }
      selected = await guessTarget();
      // Keep the guess only if that build was actually published here.
      if (!manifest.builds.some((b) => b.id === selected)) selected = manifest.builds[0]?.id ?? "";
      host.hidden = !wanted || manifest.builds.length === 0;
    })());
  }

  function render(): void {
    const builds = manifest?.builds ?? [];
    const build = builds.find((b) => b.id === selected);
    if (!build) {
      pop.innerHTML = `<div class="agent-dl-head">No prebuilt agents are published here.</div>
        <p class="agent-dl-note">Run <code>bun run agent</code> from a checkout instead.</p>`;
      return;
    }

    const others = builds.filter((b) => b.id !== build.id);
    pop.innerHTML = `
      <div class="agent-dl-head">Run the agent on your machine</div>
      <p class="agent-dl-note">The editor needs a small process next to your files — this page cannot
        open folders or run <code>git</code> on its own.</p>
      <a class="t-btn t-btn-primary agent-dl-get" href="${esc(build.url)}">⤓ ${esc(build.label)}${
        build.size ? ` · ${mb(build.size)}` : ""
      }</a>
      ${
        others.length
          ? `<div class="agent-dl-others">${others
              .map((b) => `<button type="button" data-id="${esc(b.id)}">${esc(b.label)}</button>`)
              .join("")}</div>`
          : ""
      }
      <div class="agent-dl-steps">
        <div class="agent-dl-steps-head">
          <span>then, in a terminal</span>
          <button type="button" class="t-btn agent-dl-copy">copy</button>
        </div>
        <pre>${esc(commands(build, location.origin))}</pre>
      </div>
      <p class="agent-dl-note">${caveat(build)}</p>
      ${
        build.sha256
          ? `<div class="agent-dl-sum" title="${esc(build.sha256)}"><span>sha256</span>
             <code>${esc(build.sha256.slice(0, 16))}…</code>
             <button type="button" class="t-btn agent-dl-copy-sum">copy</button></div>`
          : ""
      }
      <p class="agent-dl-note">Paste the <code>ws://127.0.0.1…</code> URL it prints into
        <b>connect…</b> above.</p>`;

    for (const b of pop.querySelectorAll<HTMLButtonElement>(".agent-dl-others button")) {
      b.addEventListener("click", () => {
        selected = b.dataset.id!;
        render();
      });
    }
    pop.querySelector(".agent-dl-copy")?.addEventListener("click", (e) => {
      void copy(commands(build, location.origin), e.currentTarget as HTMLElement);
    });
    pop.querySelector(".agent-dl-copy-sum")?.addEventListener("click", (e) => {
      void copy(build.sha256 ?? "", e.currentTarget as HTMLElement);
    });
  }

  async function copy(text: string, button: HTMLElement): Promise<void> {
    try {
      await navigator.clipboard.writeText(text);
      const was = button.textContent;
      button.textContent = "copied";
      setTimeout(() => (button.textContent = was), 1200);
    } catch {
      button.textContent = "copy failed";
    }
  }

  return {
    setVisible(visible: boolean): void {
      wanted = visible;
      if (!visible) {
        host.hidden = true;
        close();
        return;
      }
      if (!manifest) {
        void load();
        return;
      }
      host.hidden = manifest.builds.length === 0;
    },
  };
}
