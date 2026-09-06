// Cache successful catalog responses only. Clone both ways because enrichment
// appends related entities to the returned page.
export class SearchCache<T> {
  private entries = new Map<string, { expires: number; value: T }>();

  constructor(private ttlMs = 300_000, private capacity = 60) {}

  get(key: string): T | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    this.entries.delete(key);
    if (entry.expires <= Date.now()) return undefined;
    this.entries.set(key, entry);
    return structuredClone(entry.value);
  }

  set(key: string, value: T) {
    this.entries.delete(key);
    this.entries.set(key, { expires: Date.now() + this.ttlMs, value: structuredClone(value) });
    if (this.entries.size > this.capacity) {
      this.entries.delete(this.entries.keys().next().value!);
    }
  }
}
