/** Putting the connection URL on the system clipboard at startup.
 *
 *  The URL carries a token that is new on every run, so without this the first
 *  thing anyone does after starting the agent is select a line of terminal
 *  output with the mouse. There is no way for a process to offer a "copy"
 *  button in a terminal — catching a keypress would mean holding the terminal
 *  in raw mode, which breaks Ctrl+C, pipes, and running without a TTY at all —
 *  so the agent simply does the copying itself.
 *
 *  Shelling out to the platform's clipboard tool rather than taking a
 *  dependency: each is one process spawn, and they are the tools the user's
 *  desktop already ships.
 */

/** Candidate commands for this platform, in the order they should be tried.
 *  Each reads the text from stdin.
 *
 *  Linux has no single answer: wl-copy is Wayland, xclip and xsel are X11, and
 *  a desktop may have any combination installed. Wayland comes first because a
 *  session running it usually also has XWayland, where an X11 tool would put
 *  the text on a clipboard the compositor's own applications do not read. */
function clipboardTools(): string[][] {
  switch (process.platform) {
    case "win32":
      return [["clip"]];
    case "darwin":
      return [["pbcopy"]];
    default:
      return [["wl-copy"], ["xclip", "-selection", "clipboard"], ["xsel", "--clipboard", "--input"]];
  }
}

/** Whether the text reached the clipboard. A failure is not an error worth
 *  stopping for: the URL is printed either way, and the whole feature is a
 *  convenience. */
export async function copyToClipboard(text: string): Promise<boolean> {
  for (const argv of clipboardTools()) {
    try {
      const proc = Bun.spawn(argv, { stdin: "pipe", stdout: "ignore", stderr: "ignore" });
      proc.stdin.write(text);
      await proc.stdin.end();
      if ((await proc.exited) === 0) return true;
    } catch {
      // not installed, or not executable — try the next one
    }
  }
  return false;
}

/** Whether stdout is a terminal a person is watching.
 *
 *  This gates the copy, and gating it matters: the smoke suite starts agents in
 *  a loop with their output piped, and every one of them would otherwise
 *  overwrite whatever the developer had on their clipboard. */
export const interactive = (): boolean => Boolean(process.stdout.isTTY);
