/** Dev entrypoint: `bun run code-agent`.
 *
 *  The compiled binary reaches the code-agent through `server code-agent …` (see
 *  src/server.ts), but that module statically imports the built frontend from
 *  public/, so it cannot run before `bun run build`. This entrypoint skips that
 *  dependency so the code-agent can be developed and smoke-tested on its own.
 */
import { startCodeAgent } from "./main.ts";

await startCodeAgent(process.argv.slice(2));
