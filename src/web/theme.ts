/** Which theme the app is in, and who decided.
 *
 *  Three states, not two: dark, light, and "whatever the desktop is set to" —
 *  the last one being the default, and the reason this module exists. The app
 *  used to read `localStorage === "dark"`, so a first visit was light on a
 *  machine that had asked for dark everywhere else, and the browser chrome
 *  (which follows `<meta name="theme-color">`, and therefore the system) framed
 *  a white page in black.
 *
 *  Absence of the key is the third state. Nothing is written until someone
 *  works the toggle, and until then the system is followed live — flip the
 *  desktop to dark at sunset and the open tab goes with it.
 *
 *  The stylesheet knows about this too: `:root` with no `data-theme` attribute
 *  is painted from `prefers-color-scheme`, which covers the moment before this
 *  code has run at all.
 */

const KEY = "enc-theme";

/** The explicit choice, or null while the system is in charge. */
export function storedTheme(): "dark" | "light" | null {
  try {
    const value = localStorage.getItem(KEY);
    return value === "dark" || value === "light" ? value : null;
  } catch {
    return null; // private mode: no memory, but the system preference still works
  }
}

export function rememberTheme(dark: boolean): void {
  try {
    localStorage.setItem(KEY, dark ? "dark" : "light");
  } catch {
    /* ignore quota / privacy-mode errors */
  }
}

const systemQuery = (): MediaQueryList | null =>
  typeof window === "undefined" || !window.matchMedia ? null : window.matchMedia("(prefers-color-scheme: dark)");

export const systemPrefersDark = (): boolean => systemQuery()?.matches ?? false;

/** What the app should be in right now. */
export const prefersDark = (): boolean => {
  const chosen = storedTheme();
  return chosen ? chosen === "dark" : systemPrefersDark();
};

/** Follow the desktop while no explicit choice has been made. The callback is
 *  not fired for a user who has picked a side — their choice outranks the
 *  system, and silently overriding it would make the toggle look broken. */
export function watchSystemTheme(onChange: (dark: boolean) => void): void {
  systemQuery()?.addEventListener("change", (e) => {
    if (storedTheme() === null) onChange(e.matches);
  });
}
