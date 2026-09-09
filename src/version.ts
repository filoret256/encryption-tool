/** The single place the version is stated.
 *
 *  It matters beyond bookkeeping: users download a compiled agent and then keep
 *  it, so a browser tab and the agent it talks to drift apart on their own. Both
 *  sides carry this constant, and the capability badge compares them (see
 *  src/web/code/caps.ts) so a stale agent is reported rather than discovered as
 *  an unexplained protocol error.
 *
 *  Keep in step with package.json.
 */
export const VERSION = "3.1.0";
