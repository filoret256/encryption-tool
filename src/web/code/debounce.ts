/** Run `fn` once the calls have stopped for `ms`.
 *
 *  For a field whose every keystroke starts work over a long list: the work is done for the text
 *  that is there when the typing pauses, not for each letter on the way. `flush` runs a pending
 *  call now — for the moment somebody presses Enter before the pause is over and what they are
 *  about to act on has to be what is typed — and `cancel` drops it.
 */
export interface Debounced {
  (): void;
  flush(): void;
  cancel(): void;
}

export function debounce(fn: () => void, ms: number): Debounced {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const run = (): void => {
    timer = undefined;
    fn();
  };
  const d = (() => {
    clearTimeout(timer);
    timer = setTimeout(run, ms);
  }) as Debounced;
  d.flush = () => {
    if (timer === undefined) return;
    clearTimeout(timer);
    run();
  };
  d.cancel = () => {
    clearTimeout(timer);
    timer = undefined;
  };
  return d;
}
