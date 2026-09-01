// Tiny subsequence fuzzy matcher for the command palette. Returns a score
// (higher = better) or null if `query` isn't a subsequence of `text`.
// Rewards consecutive matches and matches at word starts.
export function fuzzyScore(query: string, text: string): number | null {
  if (!query) return 0;
  const q = query.toLowerCase();
  const t = text.toLowerCase();
  let score = 0;
  let qi = 0;
  let prevMatch = -2;
  for (let ti = 0; ti < t.length && qi < q.length; ti++) {
    if (t[ti] === q[qi]) {
      score += 1;
      if (ti === prevMatch + 1) score += 3; // consecutive
      if (ti === 0 || /[\s/\\:_.-]/.test(t[ti - 1])) score += 2; // word start
      prevMatch = ti;
      qi++;
    }
  }
  return qi === q.length ? score : null;
}

export function fuzzyFilter<T>(query: string, items: T[], key: (i: T) => string): T[] {
  return items
    .map((item) => ({ item, score: fuzzyScore(query, key(item)) }))
    .filter((r): r is { item: T; score: number } => r.score !== null)
    .sort((a, b) => b.score - a.score)
    .map((r) => r.item);
}
