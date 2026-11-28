/**
 * Virtual time for the search benchmark. Timers, Date.now, performance.now and
 * AbortSignal.timeout follow a simulated clock that jumps straight to the next timer once
 * every pending promise has settled, so a 1.2 s merge window costs no wall time and every
 * run of the same inputs takes the same simulated path.
 */
type Timer = { at: number; seq: number; fn: (...args: unknown[]) => void; args: unknown[]; interval?: number };

const realSetImmediate = globalThis.setImmediate;
export const realNow = performance.now.bind(performance);
const realDateNow = Date.now;

export class VirtualClock {
  now = 0;
  private epoch = 1_800_000_000_000;
  private seq = 0;
  private timers = new Map<number, Timer>();
  /** Real work (a live request while filling fixtures) the clock must not run ahead of. */
  private blockers = new Set<Promise<unknown>>();

  install() {
    const clock = this;
    globalThis.setTimeout = ((fn: (...args: unknown[]) => void, ms = 0, ...args: unknown[]) => clock.add(fn, ms, args)) as unknown as typeof setTimeout;
    globalThis.setInterval = ((fn: (...args: unknown[]) => void, ms = 0, ...args: unknown[]) => clock.add(fn, ms, args, Math.max(1, ms))) as unknown as typeof setInterval;
    globalThis.clearTimeout = ((id?: number) => { if (id !== undefined) clock.timers.delete(Number(id)); }) as typeof clearTimeout;
    globalThis.clearInterval = globalThis.clearTimeout as unknown as typeof clearInterval;
    Date.now = () => clock.epoch + clock.now;
    performance.now = () => clock.now;
    AbortSignal.timeout = (ms: number) => {
      const controller = new AbortController();
      clock.add(() => controller.abort(new DOMException("The operation timed out.", "TimeoutError")), ms, []);
      return controller.signal;
    };
  }

  private add(fn: (...args: unknown[]) => void, ms: number, args: unknown[], interval?: number) {
    const id = ++this.seq;
    this.timers.set(id, { at: this.now + Math.max(0, Number(ms) || 0), seq: id, fn, args, interval });
    return id;
  }

  block(work: Promise<unknown>) {
    this.blockers.add(work);
    void work.finally(() => this.blockers.delete(work)).catch(() => {});
  }

  /** Lets every queued promise reaction run. */
  async flush() {
    for (let i = 0; i < 3; i++) await new Promise(resolve => realSetImmediate(resolve));
    while (this.blockers.size) {
      await Promise.allSettled([...this.blockers]);
      for (let i = 0; i < 3; i++) await new Promise(resolve => realSetImmediate(resolve));
    }
  }

  /** Runs timers in order until none is due before `limit` (simulated ms from now). */
  async run(limit: number) {
    const end = this.now + limit;
    for (;;) {
      await this.flush();
      let next: Timer | undefined;
      for (const timer of this.timers.values()) if (!next || timer.at < next.at || (timer.at === next.at && timer.seq < next.seq)) next = timer;
      if (!next || next.at > end) break;
      this.now = Math.max(this.now, next.at);
      if (next.interval) next.at = this.now + next.interval;
      else this.timers.delete(next.seq);
      try { next.fn(...next.args); } catch (error) { console.error("timer threw", error); }
    }
    this.now = Math.max(this.now, Math.min(end, this.now));
  }

  /** Forgets every timer and moves far ahead, so caches with a TTL start cold. */
  reset(gapMs = 3_600_000) {
    this.timers.clear();
    this.now += gapMs;
  }
}

export const wallClock = { now: realNow, dateNow: realDateNow };
