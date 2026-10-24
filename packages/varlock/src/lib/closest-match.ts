/**
 * Levenshtein distance, kept dependency-free for "did you mean" suggestions.
 */
export function levenshtein(a: string, b: string): number {
  const rows = a.length + 1;
  const cols = b.length + 1;
  const dist: Array<Array<number>> = Array.from({ length: rows }, () => new Array(cols).fill(0));
  for (let i = 0; i < rows; i++) dist[i][0] = i;
  for (let j = 0; j < cols; j++) dist[0][j] = j;
  for (let i = 1; i < rows; i++) {
    for (let j = 1; j < cols; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dist[i][j] = Math.min(
        dist[i - 1][j] + 1,
        dist[i][j - 1] + 1,
        dist[i - 1][j - 1] + cost,
      );
    }
  }
  return dist[a.length][b.length];
}

/**
 * Closest candidate to a typed name, compared case-insensitively, or undefined when nothing
 * is close enough. Short names only allow a single edit, so `@out` does not match `@docs`.
 */
export function findClosestName(typed: string, candidates: Iterable<string>): string | undefined {
  const typedLower = typed.toLowerCase();
  const maxDistance = typed.length <= 4 ? 1 : 2;
  let best: { name: string, distance: number } | undefined;
  for (const candidate of candidates) {
    const distance = levenshtein(typedLower, candidate.toLowerCase());
    if (distance <= maxDistance && (!best || distance < best.distance)) {
      best = { name: candidate, distance };
    }
  }
  return best?.name;
}
