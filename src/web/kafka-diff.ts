/** The schema diff's own bundle (V-23, X-11).
 *
 *  The diff view pulls in every CodeMirror grammar through the code tab's `grammarFor`, which
 *  was more than half of kafka.js — for a view most people never open. This entry is built to
 *  its own file and fetched the first time two schema versions are compared.
 *
 *  It is built together with code.ts, with --splitting: the editor and the grammars are one
 *  chunk (editor-chunk.js) that both import, so a page that has opened the code tab does not
 *  fetch them again for a diff, and there is one copy of @codemirror/view on the page. The
 *  chunk's name is fixed by --chunk-naming, so server.ts embeds it like the other bundles. */
export { DiffView } from "./code/diff.ts";
