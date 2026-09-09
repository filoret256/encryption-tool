/** Dev entrypoint: `bun run agent`.
 *
 *  The compiled binary reaches the agent through `server agent …` (see
 *  src/server.ts), but that module statically imports the built frontend from
 *  public/, so it cannot run before `bun run build`. This entrypoint skips that
 *  dependency so the agent can be developed and smoke-tested on its own.
 */
import { startAgent } from "./main.ts";

await startAgent(process.argv.slice(2));
