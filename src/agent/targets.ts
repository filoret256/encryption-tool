/** The agent platforms we ship prebuilt binaries for.
 *
 *  Shared by three places that must agree on file names: the build script that
 *  produces the archives (scripts/build-agents.ts), the server that lists and
 *  serves them (src/server.ts), and the browser panel that offers the download
 *  (src/web/code/download.ts). A table rather than three string templates,
 *  because a mismatch would only show up as a 404 at download time.
 */
export interface AgentTarget {
  /** Stable id, also the suffix of the archive file name. */
  id: string;
  /** `--target` passed to `bun build --compile`. */
  bunTarget: string;
  os: "windows" | "macos" | "linux";
  arch: "x64" | "arm64";
  label: string;
  /** Name of the executable inside the archive. */
  exe: string;
  kind: "zip" | "tar.gz";
}

export const TARGETS: AgentTarget[] = [
  {
    id: "windows-x64",
    bunTarget: "bun-windows-x64",
    os: "windows",
    arch: "x64",
    label: "Windows (x64)",
    exe: "enc-tool-agent.exe",
    kind: "zip",
  },
  {
    id: "darwin-arm64",
    bunTarget: "bun-darwin-arm64",
    os: "macos",
    arch: "arm64",
    label: "macOS (Apple Silicon)",
    exe: "enc-tool-agent",
    kind: "tar.gz",
  },
  {
    id: "darwin-x64",
    bunTarget: "bun-darwin-x64",
    os: "macos",
    arch: "x64",
    label: "macOS (Intel)",
    exe: "enc-tool-agent",
    kind: "tar.gz",
  },
  {
    id: "linux-x64",
    bunTarget: "bun-linux-x64",
    os: "linux",
    arch: "x64",
    label: "Linux (x64)",
    exe: "enc-tool-agent",
    kind: "tar.gz",
  },
  {
    id: "linux-arm64",
    bunTarget: "bun-linux-arm64",
    os: "linux",
    arch: "arm64",
    label: "Linux (arm64)",
    exe: "enc-tool-agent",
    kind: "tar.gz",
  },
];

export const byId = (id: string): AgentTarget | undefined => TARGETS.find((t) => t.id === id);

/** `enc-tool-agent-3.1.0-darwin-arm64.tar.gz` — the version is in the name so a
 *  mirror can hold several releases side by side. */
export const archiveName = (t: AgentTarget, version: string): string =>
  `enc-tool-agent-${version}-${t.id}.${t.kind}`;

/** One build as published to the browser. `url` is filled in by the server:
 *  either a local route or an entry in an external mirror. */
export interface AgentBuild {
  id: string;
  os: AgentTarget["os"];
  arch: AgentTarget["arch"];
  label: string;
  exe: string;
  kind: AgentTarget["kind"];
  file: string;
  url: string;
  /** Absent when the archives are mirrored elsewhere and we only know the name. */
  size?: number;
  sha256?: string;
}
