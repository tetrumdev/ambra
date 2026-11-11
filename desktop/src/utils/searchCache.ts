// Cache successful catalog responses only. Clone both ways because enrichment
// appends related entities to the returned page.
export class SearchCache<T> {
  private entries = new Map<string, { expires: number; value: T }>();

  /**
   * `copy` makes each stored and returned value. Values nothing changes in place can be
   * shared instead (`value => value`), so every read of one entry is the same object.
   */
  // Wrapped rather than passed as is: WebKit's structuredClone throws when called as a method of the cache.
  constructor(private ttlMs = 300_000, private capacity = 60, private copy: (value: T) => T = (value) => structuredClone(value)) {}

  clear() { this.entries.clear(); }

  get(key: string): T | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    this.entries.delete(key);
    if (entry.expires <= Date.now()) return undefined;
    this.entries.set(key, entry);
    return this.copy(entry.value);
  }

  set(key: string, value: T) {
    this.entries.delete(key);
    this.entries.set(key, { expires: Date.now() + this.ttlMs, value: this.copy(value) });
    if (this.entries.size > this.capacity) {
      this.entries.delete(this.entries.keys().next().value!);
    }
  }
}
