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
