/** Browser-side client for the local kafka-agent.
 *
 *  The socket, reconnecting and the explaining of a refusal are the shared
 *  AgentClient (../agent-client.ts). What is here is what makes it the
 *  kafka-agent's: its name, its port range (5011-5020, apart from the
 *  code-agent's so that a URL says by its port which agent it belongs to), and
 *  an `op` method typed by the op table in src/kafka-agent/protocol.ts — a
 *  misspelt op or parameter is a compile error, not a blank panel.
 */
import { KAFKA_AGENT_PORT_MAX, KAFKA_AGENT_PORT_MIN } from "../../ports.ts";
import type { ClusterStatus, KafkaAgentInfo, KafkaOp, KafkaOps, MessageBatch } from "../../kafka-agent/protocol.ts";
import { AgentClient, matchAgentUrl, type AgentSpec } from "../agent-client.ts";

const SPEC: AgentSpec<KafkaAgentInfo> = {
  name: "kafka-agent",
  urlKey: "enc-kafka-agent-url",
  infoOp: "agent.info",
  portsMeta: "kafka-agent-ports",
  defaultPorts: [KAFKA_AGENT_PORT_MIN, KAFKA_AGENT_PORT_MAX],
  // The agent bounds an admin request itself (kafka-agent-go: adminTimeout = 30 s), so a
  // request that has heard nothing for longer than this is one whose answer was lost —
  // the margin over the agent's own deadline is what keeps that from being a race.
  deadlineMs: 45_000,
  check: (info) => (info && info.agent === "kafka-agent" ? null : "this is not the kafka-agent — paste the URL the kafka-agent printed"),
};

/** Does this text look like a kafka-agent URL? Only on the kafka-agent's ports,
 *  so a code-agent URL is left to paste where it was aimed. See matchAgentUrl. */
export const isKafkaAgentUrl = (text: string): boolean => matchAgentUrl(SPEC, text);

export class KafkaAgentClient extends AgentClient<KafkaAgentInfo> {
  /** What is known of each cluster's state, kept here rather than in the tab so the
   *  status badge in the header can show it — the badge is mounted with the page,
   *  the tab only when it is first opened. The tab's model writes it. */
  readonly clusterStates = new Map<string, ClusterStatus>();
  /** Told whenever clusterStates changes; set by whoever draws the badge. */
  onClusters: (() => void) | null = null;

  constructor(onState: () => void) {
    super(SPEC, onState);
  }

  /** One op, typed by the table. `onBatch` receives messages.consume's chunks. */
  op<K extends KafkaOp>(
    op: K,
    params: KafkaOps[K]["params"],
    onBatch?: (batch: MessageBatch) => void,
  ): Promise<KafkaOps[K]["result"]> {
    return this.opTracked(op, params, onBatch).promise;
  }

  /** The same, with the request id, so it can be stopped with the `cancel` op. */
  opTracked<K extends KafkaOp>(
    op: K,
    params: KafkaOps[K]["params"],
    onBatch?: (batch: MessageBatch) => void,
  ): { id: number; promise: Promise<KafkaOps[K]["result"]> } {
    return this.callTracked<KafkaOps[K]["result"]>(
      op,
      params as unknown as Record<string, unknown>,
      onBatch ? (c) => onBatch(c as MessageBatch) : undefined,
    );
  }

  /** Stop a running op. Best effort: it may already have finished. */
  cancel(id: number): void {
    void this.op("cancel", { target: id }).catch(() => undefined);
  }
}
