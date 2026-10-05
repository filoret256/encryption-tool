/** The kafka-agent's status badge — the counterpart of the code tab's
 *  (code/caps.ts), in the same chip and popover.
 *
 *  What decides whether the kafka tab works: is the kafka-agent reachable, does
 *  this engine allow a loopback socket from an https page, is the agent the
 *  version this app expects, and which of the clusters it offers actually
 *  answer. The badge reports exactly that. Like the tab it belongs to, it is
 *  shown only while that tab is open (main.ts).
 */
import { VERSION } from "../../version.ts";
import { isWebKit } from "../code/caps.ts";
import { esc } from "../code/ui.ts";
import type { KafkaAgentClient } from "./kafka-agent.ts";

type Status = "online" | "connecting" | "error" | "offline" | "blocked";

function statusOf(client: KafkaAgentClient): Status {
  if (isWebKit() && window.location.protocol === "https:") return "blocked";
  return client.state;
}

function headline(status: Status, error: string, outOfDate = false): string {
  switch (status) {
    case "online": return outOfDate ? "Connected, but the kafka-agent is out of date" : "The kafka-agent is connected";
    case "connecting": return "Connecting to the kafka-agent…";
    case "blocked": return "This browser cannot reach a local kafka-agent";
    case "error": return error || "Kafka-agent connection failed";
    default: return "The kafka tab needs the local kafka-agent";
  }
}

/** One line of the popover. Three states, as in the code badge: "?" is not a
 *  failure and carries no advice — there is nothing to advise about a cluster
 *  nobody has asked yet. */
function line(mark: "✓" | "✗" | "?", cls: "on" | "off" | "unknown", label: string, note = ""): string {
  return `<li class="${cls}"><span class="cap-mark">${mark}</span><span class="cap-label">${label}</span>${
    note ? `<span class="cap-fix">${esc(note)}</span>` : ""
  }</li>`;
}

/** Render the chip plus its popover in the header. Returns an update function,
 *  to be called whenever the agent's state or a cluster's status changes. */
export function mountKafkaBadge(host: HTMLElement, client: KafkaAgentClient, onConnect: () => void): () => void {
  host.className = "cap-badge";
  host.innerHTML = `
    <button class="cap-chip" type="button" aria-haspopup="dialog" aria-expanded="false">
      <span class="cap-dot"></span><span class="cap-text">not connected</span>
    </button>
    <div class="cap-pop" hidden></div>`;

  const chip = host.querySelector<HTMLButtonElement>(".cap-chip")!;
  const dot = host.querySelector<HTMLElement>(".cap-dot")!;
  const text = host.querySelector<HTMLElement>(".cap-text")!;
  const pop = host.querySelector<HTMLElement>(".cap-pop")!;

  chip.addEventListener("click", () => {
    const show = pop.hidden;
    pop.hidden = !show;
    chip.setAttribute("aria-expanded", String(show));
  });
  const onDocumentClick = (e: MouseEvent): void => {
    // The badge is gone (the header was rebuilt): the listener goes with it.
    if (!host.isConnected) return document.removeEventListener("click", onDocumentClick);
    if (!host.contains(e.target as Node)) {
      pop.hidden = true;
      chip.setAttribute("aria-expanded", "false");
    }
  };
  document.addEventListener("click", onDocumentClick);

  return function update(): void {
    const status = statusOf(client);
    const info = client.info;
    const clusters = info?.clusters ?? [];

    host.dataset.status = status;
    // Shown in every state, as the code-agent's chip is: the two tabs keep one header. With no
    // agent it says "not connected" rather than the agent's name, which the download button
    // beside it already says.
    dot.textContent = { online: "●", connecting: "◐", error: "✕", offline: "◌", blocked: "✕" }[status];
    // What the chip says while connected is the news, not the name: how many
    // clusters the agent offers, and whether they answer.
    const down = clusters.filter((c) => {
      const st = client.clusterStates.get(c.name);
      return st !== undefined && st.state !== "connected";
    }).length;
    text.textContent =
      status === "online"
        ? `${clusters.length} cluster${clusters.length === 1 ? "" : "s"}${down ? ` · ${down} down` : ""}`
        : status === "offline"
          ? "not connected"
          : "kafka-agent";
    chip.title =
      status === "online"
        ? `Connected — kafka-agent ${info?.version ?? ""}`
        : status === "blocked"
          ? "This browser blocks loopback connections from an https page"
          : client.lastError || "Kafka-agent not connected";

    const rows: string[] = [];
    if (status === "online") {
      rows.push(line("✓", "on", "local kafka-agent", `${info?.version ?? ""} · ${info?.platform ?? ""}`.replace(/^ · | · $/g, "")));
      rows.push(
        info?.version === VERSION
          ? line("✓", "on", "kafka-agent up to date")
          : line(
              "✗",
              "off",
              "kafka-agent up to date",
              `The kafka-agent is ${info?.version ?? "an unknown version"}, this app is ${VERSION}. Download the current one from the "⤓ kafka-agent" button on the kafka tab.`,
            ),
      );
      for (const c of clusters) {
        const st = client.clusterStates.get(c.name);
        const label = `${esc(c.name)}${c.readOnly ? "" : ` <span class="kf-tag kf-tag-warn">writable</span>`}`;
        if (!st) rows.push(line("?", "unknown", label, "Not checked yet."));
        else if (st.state === "connected") rows.push(line("✓", "on", label, st.version ?? ""));
        else rows.push(line("✗", "off", label, st.message || st.state));
      }
      if (!clusters.length) rows.push(line("✗", "off", "clusters", "The agent has none. Describe some in its kafka-agent.yaml."));
    } else {
      rows.push(line("✗", "off", "local kafka-agent", "Run `kafka-agent --config kafka-agent.yaml`, then paste its URL on the kafka tab."));
      rows.push(line("?", "unknown", "clusters", "Unknown until a kafka-agent is connected."));
    }

    pop.innerHTML = `
      <div class="cap-head">${esc(headline(status, client.lastError, status === "online" && client.info?.version !== VERSION))}</div>
      <ul class="cap-list">${rows.join("")}</ul>
      ${status === "online" ? "" : `<button class="t-btn cap-connect" type="button">connect to kafka-agent…</button>`}`;
    pop.querySelector<HTMLButtonElement>(".cap-connect")?.addEventListener("click", () => {
      pop.hidden = true;
      onConnect();
    });
  };
}
