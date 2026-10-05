/** The kafka tab: browse and manage Kafka clusters through the local
 *  kafka-agent (kafka-agent-go/).
 *
 *  Every connection setting — bootstrap servers, TLS stores and their
 *  passwords, SCRAM credentials — lives with the agent, in its config file or
 *  its arguments. The page only ever names a cluster the agent already knows,
 *  so nothing secret passes through here and the agent cannot be pointed at a
 *  host it was not configured for.
 *
 *  The layout is the code tab's: an activity rail, a side panel with the list
 *  the rail chose, and the main area for whatever is selected in it.
 */
import { applyRowHeight, copyToClipboard, esc, modalConfirm, modalPrompt, showMenu, type MenuItem } from "../code/ui.ts";
import { OutputLog } from "../code/output.ts";
import { Commands } from "../code/commands.ts";
import { iconAcls, iconBrokers, iconClusters, iconGroups, iconSchemas, iconTopics } from "./icons.ts";
import { iconRefresh } from "../code/icons.ts";
import { KafkaModel, type ViewName } from "./model.ts";
import { goToTopicOrGroup } from "./goto.ts";
import { isKafkaAgentUrl, type KafkaAgentClient } from "./kafka-agent.ts";
import { clampSideWidth, loadSide, saveSide } from "../side-width.ts";
import { AclsPanel, BrokersPanel, ClustersPanel, GroupsPanel, SubjectsPanel, TopicsPanel, STATE_TEXT, stateDot } from "./side.ts";
import { brokerView, aclView, clusterView, clustersView, emptyView, groupView, subjectView, topicView, type View } from "./views.ts";

export interface KafkaContext {
  client: KafkaAgentClient;
  isDark: () => boolean;
  notify: (notice: { message: string; isError?: boolean; onDetails?: () => void; scope?: string }) => void;
  /** Open the "⤓ kafka-agent" download in the tab strip — from the connect screen,
   *  which is where someone without an agent actually is. */
  getKafkaAgent: () => void;
  /** Take every notice off the screen: the output log's "clear" empties both. */
  dismissNotices: () => void;
}

export interface KafkaTab {
  setTheme(dark: boolean): void;
  focus(): void;
  /** main.ts owns the client and forwards its state changes here. */
  onAgentState(): void;
  /** Whether this tab is the one on screen. A live tail is stopped when it is not. */
  setActive(active: boolean): void;
  /** Connect with a URL. */
  connect(url: string): Promise<void>;
  /** Ask for the URL in a dialog, as the connect button on the card does. */
  promptConnect(): Promise<void>;
  /** Take this mount's listeners and subscriptions off, before a remount. */
  dispose(): void;
}

const VIEWS: { name: ViewName; title: string; icon: string }[] = [
  { name: "clusters", title: "Clusters", icon: iconClusters },
  { name: "topics", title: "Topics", icon: iconTopics },
  { name: "groups", title: "Consumers", icon: iconGroups },
  { name: "brokers", title: "Brokers", icon: iconBrokers },
  { name: "schemas", title: "Schemas", icon: iconSchemas },
  { name: "acls", title: "ACLs", icon: iconAcls },
];

const SHELL = `
  <div class="toolbar kf-toolbar">
    <span class="t-label">agent</span>
    <span class="kf-agent js-agent">not connected</span>
    <button class="t-btn js-agent-menu" type="button">connect…</button>
    <div class="toolbar-sep"></div>
    <span class="t-label">cluster</span>
    <span class="kf-cur js-cur">—</span>
    <button class="t-btn js-refresh" type="button" title="Ask the cluster again (Alt+R)" aria-label="Refresh the cluster">${iconRefresh}</button>
    <div class="t-spacer"></div>
  </div>
  <div class="code-body kf-body">
    <nav class="code-rail">
      ${VIEWS.map((v) => `<button class="rail-btn${v.name === "clusters" ? " active" : ""}" type="button" data-view="${v.name}" title="${v.title} (Alt+${VIEWS.indexOf(v) + 1})" aria-label="${v.title}" aria-pressed="${v.name === "clusters"}">${v.icon}</button>`).join("")}
    </nav>
    <aside class="code-side kf-side">
      <div class="side-head"><span class="js-side-title">clusters</span></div>
      <div class="side-views">
        ${VIEWS.map((v) => `<div class="side-view${v.name === "clusters" ? " active" : ""} kf-sideview" data-pane="${v.name}"></div>`).join("")}
      </div>
    </aside>
    <div class="code-splitter kf-splitter" title="Drag to resize · double-click to widen, again to put it back"></div>
    <div class="code-main kf-main"><div class="kf-mainview"></div><div class="kf-connect js-connect" hidden></div><div class="js-output"></div></div>
  </div>
  <div class="statusbar">
    <div class="sb-item js-sb-cluster">no cluster</div>
    <div class="t-spacer"></div>
    <button class="sb-item sb-button js-output-toggle" type="button" title="What the kafka-agent and the clusters said (Ctrl+J)">output</button>
  </div>`;

export function mountKafkaTab(host: HTMLElement, ctx: KafkaContext): KafkaTab {
  host.innerHTML = SHELL;
  applyRowHeight();
  const $ = <T extends HTMLElement>(sel: string): T => host.querySelector<T>(sel)!;

  // The two tabs share one panel width and the same splitter: dragged here or there, it is the
  // same record. Read again whenever this tab comes to the front, since it may have changed on
  // the other one. Collapsing is the code tab's alone (Ctrl+B): this tab has nothing to bring
  // the panel back with, so a double-click here only toggles the wide width.
  const sideEl = $<HTMLElement>(".kf-side");
  const splitter = $<HTMLElement>(".kf-splitter");
  const applySideWidth = (): void => {
    sideEl.style.width = `${clampSideWidth(loadSide().width)}px`;
  };
  applySideWidth();
  splitter.addEventListener("pointerdown", (ev) => {
    if (ev.button !== 0) return;
    ev.preventDefault(); // or the drag selects the text beside it
    splitter.setPointerCapture(ev.pointerId);
    splitter.classList.add("dragging");
    const startX = ev.clientX;
    const startWidth = sideEl.getBoundingClientRect().width;
    let width = startWidth;
    const onMove = (m: PointerEvent): void => {
      width = clampSideWidth(startWidth + m.clientX - startX);
      sideEl.style.width = `${width}px`;
    };
    const onUp = (): void => {
      splitter.classList.remove("dragging");
      splitter.removeEventListener("pointermove", onMove);
      splitter.removeEventListener("pointerup", onUp);
      saveSide({ ...loadSide(), width });
    };
    splitter.addEventListener("pointermove", onMove);
    splitter.addEventListener("pointerup", onUp);
  });
  splitter.addEventListener("dblclick", () => {
    const wide = Math.round(window.innerWidth * 0.55);
    const side = loadSide();
    const width = side.width >= wide - 8 ? 260 : wide;
    saveSide({ ...side, width });
    applySideWidth();
  });
  const { client } = ctx;
  const model = new KafkaModel(client);
  let dark = ctx.isDark();
  model.dark = dark;

  // ── the output log ──
  // Connections, what a cluster answered, and every failure with the agent's whole
  // message: a toast holds one line for a moment, and a broker's error is longer.
  const outputToggle = $<HTMLButtonElement>(".js-output-toggle");
  const output = new OutputLog(
    $(".js-output"),
    {
      onVisibility: (open) => outputToggle.classList.toggle("is-active", open),
      onChange: () => {
        const errors = output.errorCount;
        outputToggle.textContent = errors ? `output ${errors}` : "output";
        outputToggle.classList.toggle("has-errors", errors > 0);
      },
      onCleared: () => ctx.dismissNotices(),
    },
    "Nothing yet. Everything the kafka-agent and the clusters say lands here.",
  );
  outputToggle.addEventListener("click", () => output.toggle());
  model.onLog = (op, level, summary, detail) => void output.add(op, level, summary, detail);
  model.notify = (message, isError) => ctx.notify({ message, isError });

  // ── the side panels ──
  const pane = (name: ViewName): HTMLElement => $<HTMLElement>(`.kf-sideview[data-pane="${name}"]`);
  const panels = {
    clusters: new ClustersPanel(pane("clusters"), model),
    topics: new TopicsPanel(pane("topics"), model),
    groups: new GroupsPanel(pane("groups"), model),
    brokers: new BrokersPanel(pane("brokers"), model),
    schemas: new SubjectsPanel(pane("schemas"), model),
    acls: new AclsPanel(pane("acls"), model),
  };

  for (const btn of host.querySelectorAll<HTMLButtonElement>(".rail-btn")) {
    btn.addEventListener("click", () => model.setView(btn.dataset.view as ViewName));
  }
  $(".js-refresh").addEventListener("click", () => void model.refresh());
  $(".js-agent-menu").addEventListener("click", (e) => agentMenu(e.currentTarget as HTMLElement));

  /** The agent button, as the code tab's folder button: with no agent it asks for the URL;
   *  with one it opens a menu, because disconnecting, reading the config again and pasting a
   *  fresh URL are three different intentions and only the last needs a text field. */
  function agentMenu(button: HTMLElement): void {
    if (client.state !== "online") return void promptConnect();
    const items: MenuItem[] = [
      {
        label: "Disconnect from the kafka-agent",
        run: () => client.disconnectByUser(),
      },
      {
        label: "Reload the agent's config",
        hint: "no restart",
        separated: true,
        run: () => void reloadConfig(),
      },
      { label: "Connect to another kafka-agent…", separated: true, run: () => void promptConnect() },
    ];
    const at = button.getBoundingClientRect();
    showMenu(at.left, at.bottom + 2, items);
  }

  let reloading = false;
  async function reloadConfig(): Promise<void> {
    if (reloading) return;
    reloading = true;
    try {
      const r = await model.reloadConfig();
      const part = (n: string, l: string[]): string => (l.length ? `${l.length} ${n} (${l.join(", ")})` : "");
      const what = [part("added", r.added), part("removed", r.removed), part("changed", r.changed)].filter(Boolean).join(", ");
      const summary = `config reloaded — ${what || "nothing changed"}${r.warnings.length ? ` · ${r.warnings[0]}` : ""}`;
      model.log("config.reload", summary, r.warnings.length > 1 ? r.warnings.join("\n") : undefined);
      ctx.notify({ message: summary });
    } catch (e) {
      // The file was not sound, so nothing changed: the message says where. A toast is
      // one line, so the folder the file is in — which the operator knows — is left off.
      const text = e instanceof Error ? e.message : String(e);
      model.logError("config.reload", e);
      ctx.notify({ message: text.replace(/[A-Za-z]:[\\/][^\s:]*[\\/]([^\\/\s:]+\.ya?ml)/g, "$1"), isError: true, onDetails: () => output.show() });
    } finally {
      reloading = false;
    }
  }

  // ── the main area ──
  const mainHost = $<HTMLElement>(".kf-mainview");
  let current: { key: string; view: View } | null = null;

  /** What a list view needs chosen before the main area has anything to show. The selection is
   *  one thing, kept across views: a group left open on the groups list is still open when the
   *  topics list comes up, and showing it beside a topics list in which nothing is chosen read
   *  as the two disagreeing (I-03). */
  const LIST_KIND = { topics: "topic", groups: "group", brokers: "broker", schemas: "subject" } as const;
  const PICK_TEXT = { topics: "Pick a topic on the left.", groups: "Pick a group on the left.", brokers: "Pick a broker on the left.", schemas: "Pick a subject on the left." } as const;

  /** The view's list is on screen and what is selected is not one of its rows. */
  function pickText(): string | null {
    const view = model.view;
    if (!(view in LIST_KIND) || !model.cluster || model.status?.state !== "connected") return null;
    const key = view as keyof typeof LIST_KIND;
    return model.selection.kind === LIST_KIND[key] ? null : PICK_TEXT[key];
  }

  function mainKey(): string {
    const s = model.selection;
    if (pickText() !== null) return `${model.cluster}|pick|${model.view}`;
    // The ACLs are about the cluster and are not a thing to select: the view is
    // what shows them, whatever was selected before — a topic or a subject left
    // open must not hide the table behind it.
    if (showsAcls()) return `${model.cluster}|acls`;
    const what = s.kind === "topic" || s.kind === "group" || s.kind === "subject" ? s.name : s.kind === "broker" ? String(s.id) : "";
    return `${model.cluster}|${s.kind}|${what}`;
  }

  /** The ACL table is on screen: its view is open on a cluster that answers. */
  function showsAcls(): boolean {
    return model.cluster !== null && model.view === "acls" && model.status?.state === "connected";
  }

  function renderMain(): void {
    const s = model.selection;
    // The cluster overview follows every change of the model; the others own
    // their requests and are rebuilt only when what they show changes — and the
    // ACL table follows the model itself, so a repaint must not cost the filter
    // the letters already typed into it.
    const key = mainKey();
    const pick = pickText();
    const follows = s.kind === "cluster" && !showsAcls() && pick === null;
    if (current && current.key === key && !follows) return;
    current?.view.dispose();

    let view: View;
    if (!model.cluster) view = clustersView(model);
    else if (showsAcls()) view = aclView(model);
    else if (pick !== null) view = emptyView(pick);
    else if (s.kind === "cluster" || model.status?.state !== "connected") view = clusterView(model);
    else if (s.kind === "topic") view = topicView(model, s.name, dark);
    else if (s.kind === "group") view = groupView(model, s.name);
    else if (s.kind === "subject") view = subjectView(model, s.name, dark);
    else view = brokerView(model, s.id);

    current = { key, view };
    mainHost.replaceChildren(view.el);
    // A cluster overview has nothing to keep between paints; the rest do.
    // The ACL table is a cluster-wide page too, whatever is selected.
    if ((s.kind === "cluster" && pick === null) || showsAcls()) mainHost.dataset.kind = "cluster";
    else delete mainHost.dataset.kind;
  }

  // ── toolbar and status bar ──
  function renderChrome(): void {
    const st = model.status;
    const checking = model.cluster ? model.checking.has(model.cluster) : false;
    const state = checking ? "checking" : (st?.state ?? null);
    // The cluster is only shown while the agent still offers it: after a
    // disconnect the name is remembered for next time, but not displayed as if
    // it were open.
    const open = model.entry ? model.cluster : null;
    $(".js-cur").innerHTML = open
      ? `${stateDot(state)} ${esc(open)}${model.readOnly ? ` <span class="kf-tag">read-only</span>` : ` <span class="kf-tag kf-tag-warn">writable</span>`}`
      : "—";
    const online = client.state === "online";
    const refresh = $<HTMLButtonElement>(".js-refresh");
    refresh.disabled = !open;
    // Drawn as the code tab draws a control that needs its agent: dashed while there is none.
    refresh.classList.toggle("needs-cap", !online);
    $(".js-sb-cluster").textContent = open ? `${open} · ${st ? STATE_TEXT[st.state] : checking ? "checking…" : "not checked"}` : "no cluster";
    // The agent in the toolbar, where the code tab names its folder: what is connected, and
    // the one button that changes it.
    const info = client.info;
    const agent = $(".js-agent");
    agent.textContent = online && info ? `kafka-agent ${info.version}` : "not connected";
    agent.title = online && info ? `kafka-agent ${info.version} · ${info.platform}` : "";
    const agentButton = $<HTMLButtonElement>(".js-agent-menu");
    agentButton.textContent = online ? "agent…" : "connect…";
    agentButton.title = online ? "Disconnect, reload the config, or connect to another kafka-agent" : "Paste the URL the kafka-agent printed";
    for (const btn of host.querySelectorAll<HTMLButtonElement>(".rail-btn")) {
      btn.classList.toggle("active", btn.dataset.view === model.view);
      btn.setAttribute("aria-pressed", String(btn.dataset.view === model.view));
      // Every list but the clusters needs an agent to have anything in it — as on the code tab,
      // where search, source control and history wait for theirs.
      const needs = !online && btn.dataset.view !== "clusters";
      btn.disabled = needs;
      btn.classList.toggle("needs-cap", needs);
    }
    for (const p of host.querySelectorAll<HTMLElement>(".kf-sideview")) p.classList.toggle("active", p.dataset.pane === model.view);
    $(".js-side-title").textContent = VIEWS.find((v) => v.name === model.view)!.title.toLowerCase();
  }

  function render(): void {
    renderChrome();
    panels[model.view].render();
    renderMain();
  }
  model.subscribe(render);

  // ── connecting ──
  // The same as the code tab: a card that says what to do, one button, and a dialog with the URL in
  // a masked field. The URL carries the agent's token, and this screen is open exactly when someone
  // is sharing it or pasting a screenshot into a ticket — so it is never shown on the card.
  const connectBox = $<HTMLElement>(".js-connect");
  let connectError = "";
  let busy = false;
  /** What the card was last drawn from. While the client retries, its state changes every few
   *  seconds without anything on the card changing; drawing it again replaced the button under a
   *  mouse that was already on its way down, and the click was lost. */
  let paintedFor = "";

  /** Hand over the flag that lifts the one-tab restriction, as the code tab does.
   *
   *  The agent does not tell the page which config file it was started with, so the command is
   *  the flag alone, to be added to whatever the person starts the agent with. */
  async function offerAllowMultiple(): Promise<void> {
    const command = "kafka-agent --allow-multiple";
    const ok = await modalConfirm({
      title: "That kafka-agent is already serving another tab",
      detail: `Close the other tab, or restart the kafka-agent so it accepts more than one. Add the flag to the command you start it with (your --config stays):

${command}`,
      okLabel: "copy the command",
    });
    if (ok) await copyToClipboard(command, "Command", (message, isError) => ctx.notify({ message, isError }));
  }

  async function connect(url: string): Promise<void> {
    busy = true;
    connectError = "";
    paintConnect();
    let refusedAsBusy = false;
    try {
      await client.connect(url);
      // The code tab says so too, and the two tabs should answer a connect alike.
      ctx.notify({ message: "kafka-agent connected" });
    } catch (e) {
      connectError = e instanceof Error ? e.message : String(e);
      // A toast for the moment and the output log for the whole text, as on the code tab; the
      // note in the card stays for as long as the agent is offline.
      model.logError("agent", e);
      ctx.notify({ message: connectError, isError: true, onDetails: () => output.show() });
      refusedAsBusy = /already serving another tab/i.test(connectError);
    } finally {
      busy = false;
      paintConnect();
    }
    // After the card is drawn again, so the dialog does not hold the "connecting…" state open.
    if (refusedAsBusy) await offerAllowMultiple();
  }

  /** A kafka-agent URL sitting on the clipboard, if there is one, if the browser lets the page
   *  look, and if the answer arrives quickly.
   *
   *  Strictly an optimisation, the code tab's helper for the same reasons (code/index.ts):
   *  reading needs a permission Firefox does not offer to pages at all, and readText() does not
   *  reject while the permission prompt is up — it simply does not settle. So it races a
   *  deadline, and every failure leaves the saved URL in the dialog. */
  async function clipboardUrl(): Promise<string | null> {
    try {
      const read = navigator.clipboard.readText();
      const timeout = new Promise<null>((resolve) => setTimeout(() => resolve(null), 500));
      const text = (await Promise.race([read, timeout]))?.trim();
      return text && isKafkaAgentUrl(text) ? text : null;
    } catch {
      return null;
    }
  }

  /** Ask for the URL. It runs inside the click that asked, which is the only moment the
   *  browsers that allow reading the clipboard will. */
  async function promptConnect(): Promise<void> {
    const fromClipboard = await clipboardUrl();
    const url = await modalPrompt({
      title: "Local kafka-agent URL",
      value: fromClipboard ?? client.savedUrl(),
      placeholder: "ws://127.0.0.1:5011/ws?token=…",
      password: true,
      hint: fromClipboard
        ? "Taken from your clipboard — the kafka-agent put it there when it started. It contains the kafka-agent's token, so it is hidden until you show it."
        : "Run `kafka-agent --config kafka-agent.yaml`, then paste the URL it prints. It contains a token, so it is hidden until you show it.",
      okLabel: "connect",
    });
    if (!url) return;
    await connect(url);
  }

  function paintConnect(): void {
    const online = client.state === "online";
    connectBox.hidden = online;
    // The card takes the place of the main area while there is nothing to show in it; the rail
    // and the side panel stay where they are, as on the code tab.
    mainHost.hidden = !online;
    if (online) return;
    const error = connectError || (client.state === "error" ? client.lastError : "");
    const key = `${busy}|${error}`;
    if (key === paintedFor && connectBox.childElementCount > 0) return;
    paintedFor = key;
    // The code tab's card, step for step: the same three steps in the same words where the two
    // agents are alike, so the two tabs read as one program. What is the kafka-agent's own — the
    // config file, and settings that stay with it — is in the sentence and in the command.
    connectBox.innerHTML = `
      <div class="welcome">
        <h2>Open your Kafka clusters</h2>
        <p>The kafka tab works on clusters through a small local kafka-agent. Bootstrap servers, TLS
           stores and SCRAM logins stay in its config — no password or key reaches this page.</p>
        <ol>
          <li><b>Get the kafka-agent.</b> One binary, no installer.
              <button class="t-btn js-get" type="button">⤓ kafka-agent</button></li>
          <li><b>Run it.</b>
              <code>kafka-agent --config kafka-agent.yaml</code> — it prints a <code>ws://127.0.0.1:…</code> URL.</li>
          <li><b>Paste that URL here.</b>
              <button class="t-btn t-btn-primary js-welcome-connect" type="button"${busy ? " disabled" : ""}>${busy ? "connecting…" : "connect…"}</button></li>
        </ol>
        ${error ? `<div class="kf-note kf-note-bad">${esc(error)}</div>` : ""}
        <p class="welcome-note">The crypto tabs above need none of this — they run entirely in the browser.</p>
      </div>`;
    connectBox.querySelector(".js-get")?.addEventListener("click", () => ctx.getKafkaAgent());
    connectBox.querySelector(".js-welcome-connect")?.addEventListener("click", () => void promptConnect());
  }

  // A paste anywhere on the tab, while no agent is connected and the caret is not
  // in a field, is taken as the URL — if it is the kafka-agent's own.
  const onPaste = (ev: ClipboardEvent): void => {
    if (host.offsetParent === null || client.state === "online") return;
    const target = ev.target as HTMLElement | null;
    if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)) return;
    const text = ev.clipboardData?.getData("text") ?? "";
    if (!isKafkaAgentUrl(text)) return;
    ev.preventDefault();
    void connect(text.trim());
  };
  host.ownerDocument.addEventListener("paste", onPaste);

  let lastState = client.state;
  function onAgentState(): void {
    // Said when the connection changes, not on each retry while it stays down.
    if (client.state !== lastState) {
      lastState = client.state;
      if (client.state === "online") model.log("agent", `connected to kafka-agent ${client.info?.version ?? ""}`.trim());
      // A refused connect() has said so itself, in a toast and in the log.
      else if (client.state === "error" && !busy) model.logError("agent", client.lastError || "connection failed");
      else if (client.state === "offline") model.log("agent", "disconnected from the kafka-agent");
    }
    if (client.state === "online") void model.onOnline();
    else model.onOffline();
    paintConnect();
    render();
  }

  // ── the keyboard ──
  // Declared once, like the code tab's: the palette and the keys read the same list,
  // so nothing has a shortcut that cannot be found, or a name that cannot be typed.
  // Captured, so that Ctrl+P reaches us before the browser's print dialog does.
  const online = (): boolean => client.state === "online";
  const connected = (): boolean => online() && model.status?.state === "connected";
  const commands = new Commands();
  commands.add(
    { id: "go.name", title: "Go to topic or consumer group…", category: "go", key: "Mod+P", when: connected, run: () => void goToTopicOrGroup(model) },
    { id: "view.palette", title: "Show all commands", category: "view", key: "Mod+Shift+P", when: online, run: () => void commands.palette() },
    ...VIEWS.map((v, i) => ({
      id: `view.${v.name}`,
      title: `Show ${v.title.toLowerCase()}`,
      category: "view",
      key: `Alt+${i + 1}`,
      when: online,
      run: () => model.setView(v.name),
    })),
    { id: "view.output", title: "Toggle the output log", category: "view", key: "Mod+J", run: () => output.toggle() },
    { id: "cluster.refresh", title: "Ask the cluster again", category: "cluster", key: "Alt+R", when: () => online() && model.entry !== null, run: () => void model.refresh() },
    { id: "agent.reloadConfig", title: "Reload the agent's config", category: "agent", when: online, run: () => void reloadConfig() },
  );
  const onKeydown = (e: KeyboardEvent): void => {
    if (!host.classList.contains("active")) return;
    // A dialog is on screen: it owns the keyboard until it closes.
    if (host.ownerDocument.querySelector(".modal-back")) return;
    if (commands.handleKey(e)) e.preventDefault();
  };
  host.ownerDocument.addEventListener("keydown", onKeydown, true);

  /** Take this mount's keyboard listener off the document and its subscription
   *  off the client.
   *
   *  Called before a remount, so that the tab is mounted once in practice and
   *  can never be mounted twice by accident: the second mount replaces the
   *  markup, and without this the first one's listener and subscription stay —
   *  handling every keystroke twice and refreshing a document that is gone.
   *  The panels' ResizeObservers disconnect themselves once their markup has
   *  left the document (observeSize in code/vlist.ts). */
  let disposed = false;
  function dispose(): void {
    if (disposed) return;
    disposed = true;
    host.ownerDocument.removeEventListener("keydown", onKeydown, true);
    // Left on the document, it would answer a paste once for every time this tab was mounted:
    // one URL, as many connects (X-15).
    host.ownerDocument.removeEventListener("paste", onPaste);
    model.dispose();
  }

  paintConnect();
  render();
  // The client may already be online: main.ts reconnects the saved URL before
  // this chunk has finished loading.
  if (client.state === "online") void model.onOnline();

  return {
    setTheme(d) {
      dark = d;
      // A dialog opened from a side panel has no view of its own to be told; the model
      // carries it for them.
      model.dark = d;
      current?.view.setTheme?.(d);
    },
    // Somebody asked to connect (the header badge): the URL box is where that goes.
    setActive(active) {
      if (active) applySideWidth();
      else current?.view.suspend?.();
    },
    focus: () => connectBox.querySelector<HTMLButtonElement>(".js-welcome-connect")?.focus(),
    onAgentState,
    connect,
    promptConnect,
    dispose,
  };
}
