/** Never more than one of a thing at a time, and never more than one waiting.
 *
 *  The panels refresh on what the file watcher reports, and a build that touches
 *  a file every fifty milliseconds reports it every fifty milliseconds. Each
 *  report started a refresh — `git status` over every untracked file, and on a
 *  change under `.git` five processes more — without regard to the last one
 *  still running. They queued behind the code-agent's four process slots, each
 *  answering a question that had already been superseded, and the panel showed
 *  the state of some moment well in the past.
 *
 *  What is wanted is the newest answer, not one answer per report. So:
 *
 *   - idle: the call runs at once;
 *   - a run is in flight: the call does not start another. It queues *one* run
 *     to follow, and every caller that arrives before that run starts shares it;
 *   - the queued run starts when the one in flight has finished, whichever way.
 *
 *  However many reports arrive, at most two runs exist: the one going and the
 *  one after it. And the promise a caller gets settles only after a run that
 *  *began after the call was made* — a caller that awaits it, having just
 *  changed something, is never handed the answer to a question asked before the
 *  change. That is why this is not simply "ignore the call while busy".
 *
 *  Errors belong to the run that had them: a failed run does not cancel the one
 *  queued behind it, and each caller sees the outcome of the run it shares.
 */
export function singleFlight(run: () => Promise<void>): () => Promise<void> {
  let current: Promise<void> | null = null;
  let next: Promise<void> | null = null;

  const begin = (): Promise<void> => {
    next = null;
    const started = run();
    current = started;
    const done = (): void => {
      if (current === started) current = null;
    };
    started.then(done, done);
    return started;
  };

  return () => {
    if (!current) return begin();
    next ??= current.then(begin, begin);
    return next;
  };
}
