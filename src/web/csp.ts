/** The per-request nonce the server put in the shell.
 *
 *  style-src carries no 'unsafe-inline', so the one <style> element the app
 *  legitimately creates at runtime — CodeMirror mounting its themes — is
 *  admitted by this value and nothing else is. Read once: the shell is not
 *  reloaded without a new document, and a stale nonce would fail closed
 *  (unstyled editor) rather than open.
 *
 *  Empty when the page was opened from a file:// copy or an old cached shell,
 *  in which case CodeMirror mounts without a nonce and the styles are dropped —
 *  visible immediately, which is the failure mode to prefer.
 */
export const cspNonce: string =
  document.querySelector<HTMLMetaElement>('meta[name="csp-nonce"]')?.content ?? "";
