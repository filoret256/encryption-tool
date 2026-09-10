/** The loopback ports the agent may bind, and the page may connect to.
 *
 *  Two independent processes have to agree on this range. The agent picks a
 *  port to listen on (src/agent/main.ts, agent-go/main.go); the page is only
 *  allowed to open a connection to the ports named in its own connect-src
 *  (src/server.ts). Disagreement is silent and expensive: the browser refuses
 *  the socket before a packet leaves, which is indistinguishable from an agent
 *  that never started, so the user goes off to debug a process that is working
 *  perfectly.
 *
 *  Ten ports is enough for the folders one person has open at once, and small
 *  enough that the policy can still name every one of them. Naming them is the
 *  point: `connect-src ... :*` would hand injected script a channel to every
 *  other service on the machine, which is a far larger grant than the one
 *  thing the tab actually needs.
 */
export const AGENT_PORT_MIN = 5001;
export const AGENT_PORT_MAX = 5010;

/** "5001-5010" — the spelling used in help text, in the shell's meta tag and
 *  in the AGENT_PORTS environment variable. */
export const AGENT_PORT_RANGE = `${AGENT_PORT_MIN}-${AGENT_PORT_MAX}`;

/** Every port in the range, in the order the agent tries to bind them. */
export const agentPortRange = (): number[] =>
  Array.from({ length: AGENT_PORT_MAX - AGENT_PORT_MIN + 1 }, (_, i) => AGENT_PORT_MIN + i);
