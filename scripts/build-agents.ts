/** Cross-compile the local agent for every desktop platform and pack the
 *  results for download: `bun run agents:build`.
 *
 *  The web app is meant to run in a container, where an agent would be useless
 *  — it would expose the pod's filesystem, not the user's repository, and its
 *  loopback is not the browser's loopback. So the deployment ships the binaries
 *  instead, and the code tab hands them out.
 *
 *  What ships is the Go agent (agent-go/): a Bun binary embeds the whole
 *  runtime, so the same program costs 25-40 MB compressed there against roughly
 *  3 MB here. `--runtime bun` still builds the TypeScript one, which is what
 *  makes the two comparable when something looks wrong.
 *
 *    bun scripts/build-agents.ts [--targets a,b,c] [--runtime go|bun]
 *                                [--out dir] [--keep-binaries]
 */
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import { TARGETS, archiveName, byId, type AgentTarget } from "../src/agent/targets.ts";
import { VERSION } from "../src/version.ts";
import { pack } from "./archive.ts";
import { findGo, GO_MISSING } from "./go-toolchain.ts";

type Runtime = "go" | "bun";

interface Args {
  targets: AgentTarget[];
  out: string;
  keep: boolean;
  runtime: Runtime;
}

function parse(argv: string[]): Args {
  const a: Args = { targets: TARGETS, out: "dist/agents", keep: false, runtime: "go" };
  for (let i = 0; i < argv.length; i++) {
    const [flag, inline] = argv[i].split(/=(.*)/s);
    const value = (): string => inline ?? argv[++i] ?? "";
    switch (flag) {
      case "--targets": {
        // An empty list is a deliberate "build none" — it is how a Docker build
        // opts out of the ~160 MB the full set adds to the image.
        const ids = value().split(/[,\s]+/).filter(Boolean);
        a.targets = ids.map((id) => {
          const t = byId(id);
          if (!t) throw new Error(`unknown target "${id}"; known: ${TARGETS.map((x) => x.id).join(", ")}`);
          return t;
        });
        break;
      }
      case "--out": a.out = value(); break;
      case "--keep-binaries": a.keep = true; break;
      case "--runtime": {
        const r = value();
        if (r !== "go" && r !== "bun") throw new Error(`--runtime must be go or bun, got "${r}"`);
        a.runtime = r;
        break;
      }
      case "--help":
        console.log(`build-agents — cross-compile and pack the local agent

  --targets <ids>    comma-separated, or empty to build none
                     (${TARGETS.map((t) => t.id).join(", ")})
  --out <dir>        output directory (default: dist/agents)
  --runtime <name>   go (default) or bun — which implementation to ship.
                     The Go build is ~7 MB per platform against Bun's ~60-100,
                     because a Bun binary embeds the whole runtime.
  --keep-binaries    leave the uncompressed executables next to the archives`);
        process.exit(0);
    }
  }
  return a;
}

const mb = (n: number): string => `${(n / 1048576).toFixed(1)} MB`;

const args = parse(process.argv.slice(2));
await mkdir(args.out, { recursive: true });
const work = join(args.out, ".build");
await mkdir(work, { recursive: true });

interface Manifest {
  version: string;
  generated: string;
  /** Which implementation produced these archives. Recorded because the two
   *  differ by an order of magnitude in size, and a stale directory is
   *  otherwise indistinguishable from a fresh one. */
  runtime: Runtime;
  builds: {
    id: string;
    os: AgentTarget["os"];
    arch: AgentTarget["arch"];
    label: string;
    exe: string;
    kind: AgentTarget["kind"];
    file: string;
    size: number;
    sha256: string;
  }[];
}

const manifest: Manifest = { version: VERSION, generated: new Date().toISOString(), runtime: args.runtime, builds: [] };

/** `go build` for one target.
 *
 *  CGO_ENABLED=0 is what makes this work at all from a single Linux image: with
 *  cgo off, every target is a pure-Go static link needing no cross toolchain,
 *  no target SDK and no libc on the far side. -trimpath keeps the build machine's
 *  paths out of the binary, and -s -w drop the symbol and DWARF tables the agent
 *  has no use for — about a third of the size.
 *
 *  The output path is resolved before the spawn: the build runs in agent-go/, so
 *  anything relative would land inside the module. Resolving here means --out
 *  takes a path of either kind — dist/agents from the package script, an
 *  absolute /agents from the Dockerfile — and both mean what they say.
 */
async function goBuild(go: string, t: AgentTarget, outfile: string): Promise<void> {
  const proc = Bun.spawn(
    [go, "build", "-trimpath", "-ldflags", `-s -w -X main.version=${VERSION}`, "-o", resolve(outfile), "."],
    {
      cwd: "agent-go",
      env: { ...process.env, GOOS: t.goos, GOARCH: t.goarch, CGO_ENABLED: "0" },
      stdout: "inherit",
      stderr: "inherit",
      stdin: "ignore",
    },
  );
  if ((await proc.exited) !== 0) throw new Error(`go build failed for ${t.id}`);
}

async function bunBuild(t: AgentTarget, outfile: string): Promise<void> {
  const proc = Bun.spawn(
    [
      "bun", "build", "--compile", "--minify", "--sourcemap=none",
      `--target=${t.bunTarget}`, "--outfile", outfile, "src/agent/cli.ts",
    ],
    { stdout: "inherit", stderr: "inherit", stdin: "ignore" },
  );
  if ((await proc.exited) !== 0) throw new Error(`compile failed for ${t.id}`);
}

const go = args.runtime === "go" && args.targets.length ? await findGo() : null;
if (args.runtime === "go" && args.targets.length && !go) throw new Error(GO_MISSING);

for (const t of args.targets) {
  const started = Date.now();
  // Bun appends .exe for Windows targets, so ask for the final name directly.
  const outfile = join(work, t.exe);
  if (go) await goBuild(go, t, outfile);
  else await bunBuild(t, outfile);

  const binary = await readFile(outfile);
  const archive = pack(t.kind, [{ name: t.exe, data: binary, mode: 0o755 }]);
  const file = archiveName(t, VERSION);
  await writeFile(join(args.out, file), archive);
  if (args.keep) await writeFile(join(args.out, `${t.id}-${t.exe}`), binary);
  await rm(outfile, { force: true });

  manifest.builds.push({
    id: t.id,
    os: t.os,
    arch: t.arch,
    label: t.label,
    exe: t.exe,
    kind: t.kind,
    file,
    size: archive.length,
    sha256: createHash("sha256").update(archive).digest("hex"),
  });
  console.log(
    `  ${t.id.padEnd(14)} ${mb(binary.length).padStart(8)} -> ${mb(archive.length).padStart(8)}  ${file}  (${((Date.now() - started) / 1000).toFixed(1)}s)`,
  );
}

await rm(work, { recursive: true, force: true });
await writeFile(join(args.out, "agents.json"), `${JSON.stringify(manifest, null, 2)}\n`);
// A plain SHA256SUMS as well, so `sha256sum -c` works for anyone who mirrors
// the archives outside this app.
await writeFile(
  join(args.out, "SHA256SUMS"),
  manifest.builds.map((b) => `${b.sha256}  ${b.file}\n`).join(""),
);

// Rebuilding a subset into a directory that already holds a full set replaces
// the manifest, and the server serves only what the manifest lists — so the
// leftovers become invisible dead weight. Say so rather than let someone
// wonder why four platforms vanished from the panel.
const published = new Set(manifest.builds.map((b) => b.file));
const orphans = (await readdir(args.out)).filter(
  (f) => /\.(zip|tar\.gz)$/.test(f) && !published.has(f),
);
if (orphans.length) {
  console.warn(
    `\nwarning: ${orphans.length} archive(s) in ${args.out} are not in the new manifest and will not be served:\n` +
      orphans.map((f) => `  ${f}`).join("\n") +
      `\n  rebuild every target, or delete them.`,
  );
}

const total = manifest.builds.reduce((n, b) => n + b.size, 0);
console.log(
  manifest.builds.length
    ? `\n${manifest.builds.length} archive(s), ${mb(total)} total -> ${args.out}`
    : `\nno targets selected; wrote an empty manifest to ${args.out}`,
);
