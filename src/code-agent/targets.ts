/** The code-agent platforms we ship prebuilt binaries for.
 *
 *  Shared by three places that must agree on file names: the build script that
 *  produces the archives (scripts/build-code-agents.ts), the server that lists and
 *  serves them (src/server.ts), and the browser panel that offers the download
 *  (src/web/code/download.ts). A table rather than three string templates,
 *  because a mismatch would only show up as a 404 at download time.
 */
export interface CodeAgentTarget {
  /** Stable id, also the suffix of the archive file name. */
  id: string;
  /** `--target` passed to `bun build --compile`. */
  bunTarget: string;
  /** GOOS/GOARCH for `go build`. The Go code-agent is what ships; the Bun target
   *  stays so the original implementation can still be built for comparison. */
  goos: string;
  goarch: string;
  os: "windows" | "macos" | "linux";
  arch: "x64" | "arm64";
  label: string;
  /** Name of the executable inside the archive. */
  exe: string;
  kind: "zip" | "tar.gz";
}

export const TARGETS: CodeAgentTarget[] = [
  {
    id: "windows-x64",
    bunTarget: "bun-windows-x64",
    goos: "windows",
    goarch: "amd64",
    os: "windows",
    arch: "x64",
    label: "Windows (x64)",
    exe: "code-agent.exe",
    kind: "zip",
  },
  {
    id: "darwin-arm64",
    bunTarget: "bun-darwin-arm64",
    goos: "darwin",
    goarch: "arm64",
    os: "macos",
    arch: "arm64",
    label: "macOS (Apple Silicon)",
    exe: "code-agent",
    kind: "tar.gz",
  },
  {
    id: "darwin-x64",
    bunTarget: "bun-darwin-x64",
    goos: "darwin",
    goarch: "amd64",
    os: "macos",
    arch: "x64",
    label: "macOS (Intel)",
    exe: "code-agent",
    kind: "tar.gz",
  },
  {
    id: "linux-x64",
    bunTarget: "bun-linux-x64",
    goos: "linux",
    goarch: "amd64",
    os: "linux",
    arch: "x64",
    label: "Linux (x64)",
    exe: "code-agent",
    kind: "tar.gz",
  },
  {
    id: "linux-arm64",
    bunTarget: "bun-linux-arm64",
    goos: "linux",
    goarch: "arm64",
    os: "linux",
    arch: "arm64",
    label: "Linux (arm64)",
    exe: "code-agent",
    kind: "tar.gz",
  },
];

export const byId = (id: string): CodeAgentTarget | undefined => TARGETS.find((t) => t.id === id);

/** The two local agents this app hands out. They are built for the same
 *  platforms, from the same table, and differ in a name and a source folder. */
export type AgentName = "code-agent" | "kafka-agent";

/** The executable's name inside the archive: the table says `code-agent`, and
 *  the other agent is the same file under its own name. */
export const exeName = (t: CodeAgentTarget, agent: AgentName = "code-agent"): string =>
  t.exe.replace(/^code-agent/, agent);

/** `code-agent-4.0.0-darwin-arm64.tar.gz` — the version is in the name so a
 *  mirror can hold several releases side by side. */
export const archiveName = (t: CodeAgentTarget, version: string, agent: AgentName = "code-agent"): string =>
  `${agent}-${version}-${t.id}.${t.kind}`;

/** The manifest an agent's build writes and the server reads: `code-agents.json`. */
export const manifestName = (agent: AgentName): string => `${agent}s.json`;

/** One build as published to the browser. `url` is filled in by the server:
 *  either a local route or an entry in an external mirror. */
export interface CodeAgentBuild {
  id: string;
  os: CodeAgentTarget["os"];
  arch: CodeAgentTarget["arch"];
  label: string;
  exe: string;
  kind: CodeAgentTarget["kind"];
  file: string;
  url: string;
  /** Absent when the archives are mirrored elsewhere and we only know the name. */
  size?: number;
  sha256?: string;
}
