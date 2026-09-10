/** Run the Go toolchain against agent-go/, wherever it happens to live.
 *
 *  A passthrough, not an abstraction: `bun scripts/go.ts test ./...` is exactly
 *  `go test ./...` in agent-go. It exists so the package scripts work for
 *  someone whose Go is unpacked outside PATH (set GO_BIN), and so that a
 *  missing toolchain produces one clear sentence instead of "command not
 *  found" from three different places.
 *
 *    bun scripts/go.ts run . -- --root ~/project
 *    bun scripts/go.ts test ./...
 */
import { findGo, GO_MISSING } from "./go-toolchain.ts";

const go = await findGo();
if (!go) {
  console.error(`agent-go: ${GO_MISSING}`);
  process.exit(1);
}

const proc = Bun.spawn([go, ...process.argv.slice(2)], {
  cwd: "agent-go",
  stdout: "inherit",
  stderr: "inherit",
  stdin: "inherit",
});
process.exit(await proc.exited);
