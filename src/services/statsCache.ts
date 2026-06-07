/**
 * 会话内 stats 缓存（移植自 StatsCache.kt）：
 * key = `${repoPath}|${sha}|${notesOid}`，靠 notes ref OID 变化自然失效，无 TTL。
 */
export class StatsCache {
  private readonly map = new Map<string, string>();

  static key(repoPath: string, sha: string, notesOid: string): string {
    return `${repoPath}|${sha}|${notesOid}`;
  }

  get(key: string): unknown | null {
    const raw = this.map.get(key);
    if (raw === undefined) return null;
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }

  put(key: string, value: unknown): void {
    this.map.set(key, JSON.stringify(value));
  }

  clear(): number {
    const n = this.map.size;
    this.map.clear();
    return n;
  }
}
