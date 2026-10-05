/** Browser-side client for the local code-agent.
 *
 *  All of it — the socket, reconnecting, explaining a refusal — is the shared
 *  AgentClient (../agent-client.ts); this is what makes it the code-agent's:
 *  its name, its port range, and the shape of its first reply.
 */
import { CODE_AGENT_PORT_MAX, CODE_AGENT_PORT_MIN } from "../../ports.ts";
import type { CodeAgentInfo } from "../../code-agent/protocol.ts";
import { AgentClient, matchAgentUrl, type AgentSpec, type AgentState } from "../agent-client.ts";

const SPEC: AgentSpec<CodeAgentInfo> = {
  name: "code-agent",
  urlKey: "enc-code-agent-url",
  infoOp: "code-agent.info",
  portsMeta: "code-agent-ports",
  defaultPorts: [CODE_AGENT_PORT_MIN, CODE_AGENT_PORT_MAX],
  // Only reads with no side effect and no streamed chunks belong here — see
  // AgentSpec.sharedReads. The status bar and the source-control panel both want
  // `git.status` on every refresh, and the panel wants `git.branches` alongside
  // the branch picker: three round trips per wake-up where one answer would do.
  sharedReads: new Set(["git.status", "git.branches", "git.identity"]),
  // The ops that walk a whole repository, or wait on a disk, take longer than the half
  // minute an ordinary read is given (agent-client.ts). Each of them may be silent for
  // this long before the client gives up on it — git.remote is a stream, so five minutes
  // there means five minutes between two lines of progress, not five minutes in total.
  // "search" is deliberately absent: a scan of a large tree can find nothing for minutes
  // and is stopped by the reader, not by a clock (see P18 in to-do-dp.md).
  slowOps: {
    "fs.write": 120_000,
    "fs.delete": 120_000,
    "git.status": 120_000,
    "git.log": 120_000,
    "git.blame": 300_000,
    "git.commitDetail": 120_000,
    "git.blob": 60_000,
    "git.diff": 120_000,
    "git.stage": 120_000,
    "git.unstage": 120_000,
    "git.discard": 120_000,
    "git.applyPatch": 120_000,
    "git.commit": 120_000,
    "git.checkout": 180_000,
    "git.reset": 120_000,
    "git.stash": 120_000,
    "git.branchDelete": 60_000,
    "git.revert": 300_000,
    "git.cherryPick": 300_000,
    "git.merge": 300_000,
    "git.rebase": 300_000,
    "git.sequencer": 300_000,
    "git.remoteAdmin": 60_000,
    "git.remote": 300_000,
  },
  check: (info) => (info && info.codeAgent === "enc-tool" ? null : "this is not the code-agent — paste the URL the code-agent printed"),
};

/** Does this text look like a code-agent URL, rather than whatever else happens
 *  to be on the clipboard? See matchAgentUrl. */
export const isCodeAgentUrl = (text: string): boolean => matchAgentUrl(SPEC, text);

/** How long `git.remote` may be silent before the client gives up on it.
 *
 *  The panel needs the same number, and needs it from here rather than as a
 *  copy: the buttons are disabled for the duration of a fetch and only a
 *  settled request clears them, so a second clock on the same silence has to
 *  agree with this one or it fires on work that is going perfectly well. */
export const REMOTE_SILENCE_MS = SPEC.slowOps?.["git.remote"] ?? 300_000;

export type CodeAgentState = AgentState;

export class CodeAgentClient extends AgentClient<CodeAgentInfo> {
  constructor(onState: () => void) {
    super(SPEC, onState);
  }
}
