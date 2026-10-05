/** The kafka tab's icons: the same 16×16 line drawings as the code tab's
 *  (../code/icons.ts), drawn with currentColor so a button's own colour carries
 *  through. */
import { svg } from "../code/icons.ts";

/** Two stacked servers — the clusters. */
export const iconClusters = svg(
  `<rect x="2.4" y="2.6" width="11.2" height="4.2" rx="1"/><rect x="2.4" y="9.2" width="11.2" height="4.2" rx="1"/><path d="M4.9 4.7h.01M4.9 11.3h.01"/>`,
);

/** A list — the topics. */
export const iconTopics = svg(`<path d="M5.8 4h7.8M5.8 8h7.8M5.8 12h7.8"/><path d="M2.6 4h.01M2.6 8h.01M2.6 12h.01"/>`);

/** Two people — the consumer groups. */
export const iconGroups = svg(
  `<circle cx="6" cy="5.4" r="2.1"/><path d="M2.2 13c0-2.2 1.7-3.6 3.8-3.6s3.8 1.4 3.8 3.6"/><circle cx="11.6" cy="6" r="1.6"/><path d="M11 9.6c1.9 0 3 1.1 3 3"/>`,
);

/** Three joined nodes — the brokers. */
export const iconBrokers = svg(
  `<circle cx="8" cy="3.6" r="1.6"/><circle cx="3.6" cy="12" r="1.6"/><circle cx="12.4" cy="12" r="1.6"/><path d="M7.2 5 4.4 10.5M8.8 5l2.8 5.5M5.2 12h5.6"/>`,
);

/** Braces around a line — the schemas. */
export const iconSchemas = svg(
  `<path d="M6 2.6H4.6a1.6 1.6 0 0 0-1.6 1.6v2.2c0 .9-.6 1.6-1.4 1.6.8 0 1.4.7 1.4 1.6v2.2a1.6 1.6 0 0 0 1.6 1.6H6"/><path d="M10 2.6h1.4a1.6 1.6 0 0 1 1.6 1.6v2.2c0 .9.6 1.6 1.4 1.6-.8 0-1.4.7-1.4 1.6v2.2a1.6 1.6 0 0 1-1.6 1.6H10"/>`,
);

/** A shield — the ACLs. */
export const iconAcls = svg(`<path d="M8 2.2 13 4v4.2c0 3-2.1 5-5 5.6-2.9-.6-5-2.6-5-5.6V4Z"/><path d="M6.2 8.2 7.6 9.6l2.6-2.6"/>`);

/** A play triangle — consume. */
export const iconPlay = svg(`<path d="M5 3.4v9.2l7.4-4.6Z"/>`);

/** A stop square. */
export const iconStop = svg(`<rect x="4.2" y="4.2" width="7.6" height="7.6" rx="1"/>`);

/** An eye — show what is hidden by default (the internal topics). */
export const iconEye = svg(`<path d="M1.5 8S4 3.5 8 3.5 14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8Z"/><circle cx="8" cy="8" r="2"/>`);

/** A plus — make a new one. */
export const iconPlus = svg(`<path d="M8 3v10M3 8h10"/>`);

/** Two sheets — copy. */
export const iconCopy = svg(
  `<rect x="5.4" y="5.4" width="7.6" height="8" rx="1.1"/><path d="M10.6 5.4V3.6a1.1 1.1 0 0 0-1.1-1.1H4.1A1.1 1.1 0 0 0 3 3.6v6.6a1.1 1.1 0 0 0 1.1 1.1h1.3"/>`,
);
