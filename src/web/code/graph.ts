/** Commit-graph lane layout and its SVG renderer.
 *
 *  Written by hand because there is nothing maintained to use: gitgraph.js is
 *  archived and @gitgraph/js has not been released since 2021. Generic DAG
 *  layouts (dagre, d3-dag) solve a different problem — a commit graph is drawn
 *  as fixed vertical lanes in log order, not as a laid-out hierarchy.
 *
 *  The algorithm is the standard one: walk commits newest-first, keep an array
 *  of lanes where each slot holds the oid that lane is still waiting for, and
 *  never move a lane sideways so lines stay straight and stable between rows.
 */
import type { Commit } from "../../agent/protocol.ts";

export const LANE_W = 12;
export const ROW_H = 26;
/** Lane colours cycle; the CSS variables are defined in style.css. */
export const LANE_COLORS = 8;

export interface GraphRow {
  /** Column of this commit's dot. */
  lane: number;
  /** Columns in use at this row — drives the gutter width. */
  columns: number;
  /** Columns with a line passing straight through, untouched by this commit. */
  through: number[];
  /** Columns whose line comes down from the row above into this dot. */
  incoming: number[];
  /** Columns the dot sends a line down to — one per parent. */
  outgoing: number[];
  /** Columns still occupied below this row, for the expanded detail block. */
  below: number[];
  merge: boolean;
}

export function computeGraph(commits: Commit[]): GraphRow[] {
  /** lanes[i] = oid the lane is waiting to draw, or null when free. */
  const lanes: (string | null)[] = [];
  const rows: GraphRow[] = [];

  const firstFree = (): number => {
    const i = lanes.indexOf(null);
    if (i !== -1) return i;
    lanes.push(null);
    return lanes.length - 1;
  };

  for (const c of commits) {
    const before = lanes.slice();
    // Every lane waiting for this oid is a child's line arriving from above.
    const incoming: number[] = [];
    for (let i = 0; i < before.length; i++) if (before[i] === c.oid) incoming.push(i);

    const lane = incoming.length ? incoming[0] : firstFree();
    // All arriving lines terminate here; the dot continues in `lane` only.
    for (const i of incoming) lanes[i] = null;
    lanes[lane] = null;

    const outgoing: number[] = [];
    if (c.parents.length) {
      lanes[lane] = c.parents[0];
      outgoing.push(lane);
      for (const p of c.parents.slice(1)) {
        // A parent already expected elsewhere reuses that lane, which is what
        // makes a merge draw as two lines converging rather than a new column.
        let j = lanes.indexOf(p);
        if (j === -1) {
          j = firstFree();
          lanes[j] = p;
        }
        outgoing.push(j);
      }
    }
    while (lanes.length && lanes[lanes.length - 1] === null) lanes.pop();

    const after = lanes.slice();
    const through: number[] = [];
    for (let i = 0; i < before.length; i++) {
      if (i === lane || before[i] === null || before[i] === c.oid) continue;
      if (after[i] === before[i]) through.push(i);
    }

    const below: number[] = [];
    for (let i = 0; i < after.length; i++) if (after[i]) below.push(i);

    rows.push({
      lane,
      columns: Math.max(before.length, after.length, lane + 1, 1),
      through,
      incoming,
      outgoing,
      below,
      merge: c.parents.length > 1,
    });
  }
  return rows;
}

// ── rendering ─────────────────────────────────────────────────────────────

const cx = (lane: number): number => lane * LANE_W + LANE_W / 2;
const stroke = (lane: number): string => `var(--g${(lane % LANE_COLORS) + 1})`;

/** Curve from one column at the row edge to the dot in the middle. Control
 *  points are vertical at both ends so the join into a straight lane is smooth. */
function curve(fromX: number, fromY: number, toX: number, toY: number): string {
  const mid = (fromY + toY) / 2;
  return `M${fromX} ${fromY} C${fromX} ${mid} ${toX} ${mid} ${toX} ${toY}`;
}

export function laneSvg(row: GraphRow): string {
  const w = row.columns * LANE_W;
  const h = ROW_H;
  const y = h / 2;
  const x = cx(row.lane);
  const parts: string[] = [];

  for (const i of row.through) {
    parts.push(`<line x1="${cx(i)}" y1="0" x2="${cx(i)}" y2="${h}" stroke="${stroke(i)}" />`);
  }
  for (const i of row.incoming) {
    parts.push(
      i === row.lane
        ? `<line x1="${x}" y1="0" x2="${x}" y2="${y}" stroke="${stroke(i)}" />`
        : `<path d="${curve(cx(i), 0, x, y)}" stroke="${stroke(i)}" fill="none" />`,
    );
  }
  for (const j of row.outgoing) {
    parts.push(
      j === row.lane
        ? `<line x1="${x}" y1="${y}" x2="${x}" y2="${h}" stroke="${stroke(j)}" />`
        : `<path d="${curve(x, y, cx(j), h)}" stroke="${stroke(j)}" fill="none" />`,
    );
  }

  // Merges get a hollow dot so they are distinguishable at a glance.
  const dot = row.merge
    ? `<circle cx="${x}" cy="${y}" r="3.6" fill="var(--panel)" stroke="${stroke(row.lane)}" stroke-width="2" />`
    : `<circle cx="${x}" cy="${y}" r="3.4" fill="${stroke(row.lane)}" stroke="none" />`;

  return `<svg class="g-lane" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">${parts.join("")}${dot}</svg>`;
}

/** Straight continuations drawn beside an expanded commit's detail block, so
 *  the lanes are not interrupted by it. Height is 100% because the block grows
 *  with its content. */
export function continuationSvg(row: GraphRow): string {
  const w = row.columns * LANE_W;
  const lines = row.below
    .map((i) => `<line x1="${cx(i)}" y1="0" x2="${cx(i)}" y2="100%" stroke="${stroke(i)}" />`)
    .join("");
  return `<svg class="g-cont" width="${w}" height="100%" preserveAspectRatio="none">${lines}</svg>`;
}
