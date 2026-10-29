import { POPULAR_DOMAINS, TLD_TYPOS } from './lists.js';

const POPULAR_SET: ReadonlySet<string> = new Set(POPULAR_DOMAINS);

/**
 * Optimal-string-alignment distance (Levenshtein + adjacent transposition),
 * bounded by `max`. Returns `max + 1` as soon as the distance is known to exceed
 * `max`, so a scan over a candidate list costs O(n * min(m, 2*max+1)) per candidate
 * in the common no-match case instead of O(n * m).
 *
 * Transposition matters here: "gmial" -> "gmail" is one edit, not two.
 */
export function boundedOsaDistance(a: string, b: string, max: number): number {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > max) return max + 1;

  const n = b.length;
  // Three rolling rows: i-2, i-1, i.
  let prevPrev = new Array<number>(n + 1).fill(0);
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  let curr = new Array<number>(n + 1).fill(0);

  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    let rowMin = curr[0];
    const ai = a.charCodeAt(i - 1);
    for (let j = 1; j <= n; j++) {
      const bj = b.charCodeAt(j - 1);
      const cost = ai === bj ? 0 : 1;
      let v = Math.min(prev[j]! + 1, curr[j - 1]! + 1, prev[j - 1]! + cost);
      if (i > 1 && j > 1 && ai === b.charCodeAt(j - 2) && a.charCodeAt(i - 2) === bj) {
        v = Math.min(v, prevPrev[j - 2]! + 1);
      }
      curr[j] = v;
      if (v < rowMin) rowMin = v;
    }
    if (rowMin > max) return max + 1; // every path through this row already exceeds the bound
    [prevPrev, prev, curr] = [prev, curr, prevPrev];
  }
  const d = prev[n]!;
  return d > max ? max + 1 : d;
}

/**
 * Suggests a correction for a likely-mistyped domain, e.g. `gmial.com` -> `gmail.com`
 * or `acme.con` -> `acme.com`. Returns null when there is no confident suggestion.
 */
export function suggestDomain(domain: string): string | null {
  if (POPULAR_SET.has(domain)) return null;

  // Short domains get a tighter bound; otherwise "aol.com" would "correct" to many things.
  const max = domain.length <= 8 ? 1 : 2;
  let best: string | null = null;
  let bestDistance = max + 1;
  for (const candidate of POPULAR_DOMAINS) {
    const d = boundedOsaDistance(domain, candidate, max);
    if (d < bestDistance) {
      best = candidate;
      bestDistance = d;
      if (d === 1) break; // list is popularity-ordered; first distance-1 hit wins
    }
  }
  if (best !== null) return best;

  const dot = domain.lastIndexOf('.');
  const fixedTld = TLD_TYPOS[domain.slice(dot + 1)];
  return fixedTld ? `${domain.slice(0, dot)}.${fixedTld}` : null;
}
