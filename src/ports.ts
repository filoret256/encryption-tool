/** The loopback ports the code-agent may bind, and the page may connect to.
 *
 *  Two independent processes have to agree on this range. The code-agent picks a
 *  port to listen on (src/code-agent/main.ts, code-agent-go/main.go); the page is only
 *  allowed to open a connection to the ports named in its own connect-src
 *  (src/server.ts). Disagreement is silent and expensive: the browser refuses
 *  the socket before a packet leaves, which is indistinguishable from a code-agent
 *  that never started, so the user goes off to debug a process that is working
 *  perfectly.
 *
 *  Ten ports is enough for the folders one person has open at once, and small
 *  enough that the policy can still name every one of them. Naming them is the
 *  point: `connect-src ... :*` would hand injected script a channel to every
 *  other service on the machine, which is a far larger grant than the one
 *  thing the tab actually needs.
 */
export const CODE_AGENT_PORT_MIN = 5001;
export const CODE_AGENT_PORT_MAX = 5010;

/** "5001-5010" — the spelling used in help text, in the shell's meta tag and
 *  in the CODE_AGENT_PORTS environment variable. */
export const CODE_AGENT_PORT_RANGE = `${CODE_AGENT_PORT_MIN}-${CODE_AGENT_PORT_MAX}`;

/** Every port in the range, in the order the code-agent tries to bind them. */
export const codeAgentPortRange = (): number[] =>
  Array.from({ length: CODE_AGENT_PORT_MAX - CODE_AGENT_PORT_MIN + 1 }, (_, i) => CODE_AGENT_PORT_MIN + i);
