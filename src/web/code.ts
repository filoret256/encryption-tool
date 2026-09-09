/** Build entry for the code tab.
 *
 *  Bundled separately to public/code.js and imported at runtime the first time
 *  the user opens the tab: the grammar set and the explorer have no place in
 *  the bundle a visitor who only wants to decrypt a secret has to download.
 *  The filename is fixed (no --splitting) so server.ts can embed it into the
 *  standalone binary like every other asset.
 */
export { mountCodeTab } from "./code/index.ts";
export type { CodeContext, CodeTab } from "./code/index.ts";
