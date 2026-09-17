// Native commands wait for worker replies. Preserve user action order even
// when one load is slow, and let status readers reject snapshots taken mid-command.
export class NativePlaybackCommands {
  revision = 0;
  pending = 0;
  private tail: Promise<void> = Promise.resolve();

  constructor(
    private invoke: (command: string, args?: Record<string, unknown>) => Promise<unknown>,
  ) {}

  run(command: string, args?: Record<string, unknown>): Promise<void> {
    this.revision += 1;
    this.pending += 1;
    const result = this.tail.then(async () => {
      try {
        await this.invoke(command, args);
      } finally {
        this.pending -= 1;
      }
    });
    // A failed load must not prevent a subsequent skip or pause.
    this.tail = result.catch(() => {});
    return result;
  }

  acceptsStatus(revision: number) {
    return this.pending === 0 && this.revision === revision;
  }
}
