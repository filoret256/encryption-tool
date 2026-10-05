/** The side panel's width and collapsed state, remembered between sessions.
 *
 *  One record for the code tab and the kafka tab: the two are built from the same
 *  parts, and a panel that changes width when you switch tabs makes the second
 *  tab look like a different program. The code tab owns the splitter that writes
 *  it; the kafka tab, which has none, only reads it. */
export interface SideState {
  width: number;
  collapsed: boolean;
}

const SIDE_KEY = "enc-code-side";

export function loadSide(): SideState {
  const fallback: SideState = { width: 260, collapsed: false };
  try {
    return { ...fallback, ...(JSON.parse(localStorage.getItem(SIDE_KEY) ?? "{}") as Partial<SideState>) };
  } catch {
    return fallback;
  }
}

export function saveSide(s: SideState): void {
  try {
    localStorage.setItem(SIDE_KEY, JSON.stringify(s));
  } catch {
    /* private mode */
  }
}

/** The one rule about how wide the panel may be.
 *
 *  The stored number is a preference, not a measurement: a width chosen on a 1440px
 *  monitor must be read against the window it is applied to. */
export const clampSideWidth = (w: number): number => Math.round(Math.min(Math.max(w, 150), window.innerWidth * 0.6));
