/** Inline SVG icons for the code tab.
 *
 *  Inline rather than a font or sprite sheet: everything here has to survive
 *  `bun build --compile` embedding the frontend by path, and a string constant
 *  costs nothing to embed. They are drawn on a 16×16 grid with `currentColor`,
 *  so a button's own colour and hover state carry straight through.
 *
 *  Emoji were the first pass and read badly — they render in whatever the
 *  platform ships, so the rail changed shape between Windows, macOS and Linux
 *  and never matched the surrounding line weight.
 */
const svg = (body: string): string =>
  `<svg class="ic" viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.25" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${body}</svg>`;

/** A page with a folded corner — the explorer. */
export const iconFiles = svg(`<path d="M9.2 1.9H5a1.1 1.1 0 0 0-1.1 1.1v10a1.1 1.1 0 0 0 1.1 1.1h6a1.1 1.1 0 0 0 1.1-1.1V4.8Z"/><path d="M9.2 1.9v2.9h2.9"/>`);

/** Magnifier. */
export const iconSearch = svg(`<circle cx="7.1" cy="7.1" r="4.1"/><path d="m10.1 10.1 3.4 3.4"/>`);

/** Two nodes joined by a curve — source control. */
export const iconBranch = svg(`<circle cx="4.6" cy="3.4" r="1.7"/><circle cx="4.6" cy="12.6" r="1.7"/><circle cx="11.4" cy="3.4" r="1.7"/><path d="M4.6 5.1v5.8"/><path d="M11.4 5.1v1.3c0 2-1.9 2.7-4 3.1"/>`);

/** Clock — history. */
export const iconHistory = svg(`<circle cx="8" cy="8" r="5.6"/><path d="M8 4.7V8l2.3 1.4"/>`);

/** Page with a plus. */
export const iconNewFile = svg(`<path d="M9.2 1.9H5a1.1 1.1 0 0 0-1.1 1.1v10a1.1 1.1 0 0 0 1.1 1.1h6a1.1 1.1 0 0 0 1.1-1.1V4.8Z"/><path d="M9.2 1.9v2.9h2.9"/><path d="M8 8v3.4M6.3 9.7h3.4"/>`);

/** Folder with a plus. */
export const iconNewFolder = svg(`<path d="M2 4.2a1.1 1.1 0 0 1 1.1-1.1h2.6l1.3 1.6H13a1.1 1.1 0 0 1 1.1 1.1v6.4a1.1 1.1 0 0 1-1.1 1.1H3.1A1.1 1.1 0 0 1 2 12.2Z"/><path d="M8 7.6v3.6M6.2 9.4h3.6"/>`);

/** Circular arrow — reload. */
export const iconRefresh = svg(`<path d="M13.3 8a5.3 5.3 0 1 1-1.7-3.9"/><path d="M13.5 2.6v2.9h-2.9"/>`);

/* The set below covers the source-control, history and search panels, which
 * drew their buttons with characters — ⟲ ⟳ ↺ ⇄ ⑂ ⋯ — until now.
 *
 * That is the same mistake the rail made and this file was written to fix, and
 * it shows up twice. A monospace font ships none of those code points, so each
 * one is drawn by whatever fallback the OS picks: a different weight, a
 * different optical size, a different baseline, all of it varying by platform.
 * And because .t-icon sizes itself to its content, a button holding a 12px
 * character came out four pixels shorter than the identical button holding a
 * 16px icon — which is why two header bars that should have matched did not. */

/** Two arrows around a circle — fetch. */
export const iconFetch = svg(
  `<path d="M13.2 7.4a5.2 5.2 0 0 0-8.9-3"/><path d="M13.4 2.4v3h-3"/><path d="M2.8 8.6a5.2 5.2 0 0 0 8.9 3"/><path d="M2.6 13.6v-3h3"/>`,
);

/** Arrow down onto a line — pull. */
export const iconPull = svg(`<path d="M8 2.4v7.4"/><path d="M4.9 6.7 8 9.8l3.1-3.1"/><path d="M3.1 13.3h9.8"/>`);

/** Arrow up off a line — push. */
export const iconPush = svg(`<path d="M8 13.6V6.2"/><path d="M4.9 9.3 8 6.2l3.1 3.1"/><path d="M3.1 2.7h9.8"/>`);

/** Three dots — the overflow menu. */
export const iconMore = svg(
  `<circle cx="3.6" cy="8" r="1.15" fill="currentColor" stroke="none"/><circle cx="8" cy="8" r="1.15" fill="currentColor" stroke="none"/><circle cx="12.4" cy="8" r="1.15" fill="currentColor" stroke="none"/>`,
);

/** Checkmark — stage, mark resolved, commit. */
export const iconCheck = svg(`<path d="m3.4 8.4 3.1 3.2 6.1-7.2"/>`);

/** Minus — unstage. */
export const iconMinus = svg(`<path d="M3.4 8h9.2"/>`);

/** Plus — stage. Drawn rather than typed as "+", so it matches the minus it
 *  sits next to instead of being a character of a different weight. */
export const iconPlus = svg(`<path d="M8 3.4v9.2"/><path d="M3.4 8h9.2"/>`);

/** Counter-clockwise arrow — discard, the mirror of reload so the two read as
 *  opposites rather than as the same button drawn twice. */
export const iconDiscard = svg(`<path d="M2.7 8a5.3 5.3 0 1 0 1.7-3.9"/><path d="M2.5 2.6v2.9h2.9"/>`);

/** Two arrows passing — replace. */
export const iconReplace = svg(
  `<path d="M3 5.4h8"/><path d="M8.7 3 11.1 5.4 8.7 7.8"/><path d="M13 10.6H5"/><path d="M7.3 8.2 4.9 10.6l2.4 2.4"/>`,
);

/** A cross — close, dismiss. */
export const iconClose = svg(`<path d="M4.2 4.2 11.8 11.8"/><path d="M11.8 4.2 4.2 11.8"/>`);
