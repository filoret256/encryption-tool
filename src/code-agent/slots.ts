/** A counting semaphore, per connection: how many child processes one client may have running.
 *
 *  Queues rather than refuses: the client asked for work it is entitled to, and a request that
 *  waits its turn is an ordinary slow response, while one that fails is an error the UI has to
 *  explain.
 *
 *  Its own module so that a test can reach it without starting a server.
 */
export class Slots {
  /** Slots nobody holds. With the ones that are held, always the limit — that is what the two
   *  methods below keep true, and what the old `drain` did not. */
  private free: number;
  private waiting: ((held: boolean) => void)[] = [];
  private closed = false;

  constructor(limit: number) {
    this.free = limit;
  }

  /** Wait for a slot. True: it is held, and `release` gives it back. False: the connection went
   *  away while this was waiting, nothing is held, and the work is not to be started — nobody will
   *  read what it produces, and a process spawned for a closed connection counts against nothing. */
  async acquire(): Promise<boolean> {
    if (this.closed) return false;
    if (this.free > 0) {
      this.free--;
      return true;
    }
    return new Promise<boolean>((resolve) => this.waiting.push(resolve));
  }

  /** Give a held slot back: to the next in line, or to the pool. */
  release(): void {
    const next = this.waiting.shift();
    if (next) next(true);
    else this.free++;
  }

  /** The connection is going away: everyone waiting is told so, and nobody else waits. A waiter
   *  that is never resolved is a promise that never settles; one that was let through as if it had
   *  a slot ran its work and then released a slot it never held, so `free` grew past the limit and
   *  more than the limit of processes could run. */
  drain(): void {
    this.closed = true;
    for (const resolve of this.waiting.splice(0)) resolve(false);
  }
}
