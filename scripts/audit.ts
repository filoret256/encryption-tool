/** Security and quality scans: `bun run audit [--strict] [--image <tag>]`.
 *
 *  Five tools, each answering a different question, run in one place so that
 *  "was it checked" has one answer and does not depend on who remembered:
 *
 *    bun audit          known advisories in the JavaScript dependencies
 *    govulncheck        known vulnerabilities in the Go code-agent that its code reaches
 *    staticcheck        bugs and dead code in the Go code-agent (code-agent-go/staticcheck.conf)
 *    gosec              security-relevant patterns in the Go code-agent
 *    go vet             what the compiler's own checker finds
 *    trivy / grype      with --image: the built image, base layers included
 *
 *  A tool that is not installed is reported and skipped — fine on a laptop, where
 *  nobody should have to install five things to run one script — unless --strict,
 *  which is what CI passes: there a missing scanner is a scan that did not happen,
 *  and a green run that did not scan is worse than a red one.
 *
 *  gosec runs with -exclude=G301,G302,G306, the file-permission rules. The code-agent
 *  writes the user's own files in the user's own project, where 0644 and 0755 are
 *  what every other tool leaves and what a second user, a container mount or a
 *  build step expects; 0600 there would be a regression that looks like hardening.
 *  Every other finding is either fixed or marked `#nosec` at the line with the
 *  reason beside it, so a new one is a real signal.
 */
import { join } from "node:path";
import { findGo } from "./go-toolchain.ts";

const argv = process.argv.slice(2);
const strict = argv.includes("--strict");
const at = argv.indexOf("--image");
const image = at >= 0 ? argv[at + 1] : undefined;

interface Step {
  name: string;
  tool: string;
  argv: string[];
  cwd?: string;
  hint: string;
}

const go = (await findGo()) ?? "go";
const codeAgent = "code-agent-go";

const steps: Step[] = [
  { name: "bun audit", tool: "bun", argv: ["bun", "audit"], hint: "bundled with Bun" },
  { name: "go vet", tool: go, argv: [go, "vet", "./..."], cwd: codeAgent, hint: "install Go" },
  {
    name: "govulncheck",
    tool: "govulncheck",
    argv: ["govulncheck", "./..."],
    cwd: codeAgent,
    hint: "go install golang.org/x/vuln/cmd/govulncheck@v1.8.0",
  },
  {
    name: "staticcheck",
    tool: "staticcheck",
    argv: ["staticcheck", "./..."],
    cwd: codeAgent,
    hint: "go install honnef.co/go/tools/cmd/staticcheck@v0.8.1",
  },
  {
    name: "gosec",
    tool: "gosec",
    argv: ["gosec", "-quiet", "-severity", "medium", "-confidence", "medium", "-exclude=G301,G302,G306", "./..."],
    cwd: codeAgent,
    hint: "go install github.com/securego/gosec/v2/cmd/gosec@v2.29.0",
  },
];

if (image) {
  // trivy is the one the CI workflow uses; grype is accepted so a machine that has
  // that one instead is not left without an image scan.
  if (Bun.which("trivy")) {
    steps.push({
      name: `trivy ${image}`,
      tool: "trivy",
      argv: ["trivy", "image", "--exit-code", "1", "--severity", "HIGH,CRITICAL", "--ignore-unfixed", image],
      hint: "https://trivy.dev",
    });
  } else {
    steps.push({ name: `grype ${image}`, tool: "grype", argv: ["grype", image, "--fail-on", "high"], hint: "https://github.com/anchore/grype (or trivy)" });
  }
}

let failed = 0;
let skipped = 0;
for (const step of steps) {
  const found = step.tool.includes("/") || step.tool.includes("\\") ? step.tool : Bun.which(step.tool);
  if (!found) {
    if (strict) {
      failed++;
      console.log(`FAIL  ${step.name} — not installed, and --strict says a scan that did not run is a failure (${step.hint})`);
    } else {
      skipped++;
      console.log(`skip  ${step.name} — not installed (${step.hint})`);
    }
    continue;
  }
  const started = Date.now();
  const proc = Bun.spawn(step.argv, {
    cwd: step.cwd ? join(process.cwd(), step.cwd) : process.cwd(),
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
  });
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  const secs = ((Date.now() - started) / 1000).toFixed(1);
  if (code === 0) {
    console.log(`ok    ${step.name} (${secs}s)`);
  } else {
    failed++;
    console.log(`FAIL  ${step.name} (${secs}s, exit ${code})`);
    console.log(
      `${out}${err}`
        .trim()
        .split("\n")
        .slice(-40)
        .map((l) => `      ${l}`)
        .join("\n"),
    );
  }
}

console.log(`\n${steps.length - failed - skipped} passed, ${failed} failed, ${skipped} skipped`);
process.exit(failed ? 1 : 0);
