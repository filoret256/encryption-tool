/** "Go to topic or group": Ctrl+P, as "Go to file" is in the code tab.
 *
 *  One list for both kinds of thing a person goes looking for by name. Picking
 *  one switches the side panel to its kind and selects it there, exactly as
 *  clicking it would.
 */
import { quickPick, type PickItem } from "../code/quickpick.ts";
import { formatCount } from "./format.ts";
import type { KafkaModel } from "./model.ts";

/** Above this many rows the list is cut to what matches, so a cluster with tens of
 *  thousands of topics does not put all of them in the page at once. */
const SHOWN = 100;

export async function goToTopicOrGroup(model: KafkaModel): Promise<void> {
  // `t:` and `g:` keep a topic and a group of the same name apart in the value.
  const rows = (): PickItem[] => [
    ...(model.topics.data ?? []).map((t) => ({
      value: `t:${t.name}`,
      label: t.name,
      section: "topics",
      detail: t.internal ? "internal" : `${t.partitions}p · ${formatCount(t.messages)}`,
      filterText: t.name,
    })),
    ...(model.groups.data ?? []).map((g) => ({
      value: `g:${g.name}`,
      label: g.name,
      section: "consumers",
      detail: g.state,
      filterText: g.name,
    })),
  ];
  let all = rows();

  // The picker opens at once, with what is already known: a person who presses Ctrl+P and
  // starts typing must not lose the first letters to a request for the lists. When they
  // arrive the list is filled in under whatever has been typed.
  const picking = quickPick({
    title: "Go to topic or consumer group",
    placeholder: "type part of a name",
    buttons: false,
    items: (query) => {
      const needle = query.toLowerCase();
      return (needle ? all.filter((i) => i.filterText!.toLowerCase().includes(needle)) : all).slice(0, SHOWN);
    },
  });
  void model.ensureNames().then(() => {
    all = rows();
    document.querySelector<HTMLInputElement>(".quick-pick .js-filter")?.dispatchEvent(new Event("input"));
  });
  const picked = await picking;
  if (!picked) return;

  const name = picked.slice(2);
  if (picked.startsWith("t:")) {
    model.setView("topics");
    model.select({ kind: "topic", name });
  } else {
    model.setView("groups");
    model.select({ kind: "group", name });
  }
}
