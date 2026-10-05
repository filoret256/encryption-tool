/** Run the Go toolchain against one of the Go modules, wherever Go happens to live.
 *
 *  A passthrough, not an abstraction: `bun scripts/go.ts test ./...` is exactly
 *  `go test ./...` in code-agent-go, and `--in <dir>` picks another module
 *  (agent-kit-go, kafka-agent-go). It exists so the package scripts work for
 *  someone whose Go is unpacked outside PATH (set GO_BIN), and so that a
 *  missing toolchain produces one clear sentence instead of "command not
 *  found" from three different places.
 *
 *    bun scripts/go.ts run . -- --root ~/project
 *    bun scripts/go.ts test ./...
 *    bun scripts/go.ts --in agent-kit-go test ./...
 */
import { findGo, GO_MISSING } from "./go-toolchain.ts";

let args = process.argv.slice(2);
let cwd = "code-agent-go";
if (args[0] === "--in") {
  cwd = args[1] ?? "";
  args = args.slice(2);
}

const go = await findGo();
if (!go) {
  console.error(`${cwd}: ${GO_MISSING}`);
  process.exit(1);
}

const proc = Bun.spawn([go, ...args], {
  cwd,
  stdout: "inherit",
  stderr: "inherit",
  stdin: "inherit",
});
process.exit(await proc.exited);
