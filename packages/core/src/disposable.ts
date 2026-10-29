import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * Set of domains with parent-domain matching: if `mailinator.com` is listed,
 * `x.mailinator.com` matches too.
 *
 * A hash set probed once per suffix is O(labels) per lookup with O(1) probes.
 * A reversed-label trie gives the same asymptotics with worse constants and more
 * allocation, and a Bloom filter only pays off when the list is too large for
 * memory (this one is ~10k entries, a few hundred KB), so a Set is the right tool.
 */
export class DomainSet {
  private readonly domains: Set<string>;

  constructor(domains: Iterable<string>) {
    this.domains = new Set();
    for (const d of domains) {
      const v = d.trim().toLowerCase();
      if (v.length > 0 && !v.startsWith('#')) this.domains.add(v);
    }
  }

  get size(): number {
    return this.domains.size;
  }

  /** True if `domain` or any parent domain with at least two labels is in the set. */
  has(domain: string): boolean {
    let d = domain.toLowerCase();
    for (;;) {
      if (this.domains.has(d)) return true;
      const dot = d.indexOf('.');
      if (dot === -1) return false;
      const parent = d.slice(dot + 1);
      if (parent.indexOf('.') === -1) return false; // never match a bare TLD
      d = parent;
    }
  }
}

let bundled: DomainSet | null = null;

/** Loads the bundled list once per process. Works from both src/ and dist/. */
export function loadDisposableDomains(): DomainSet {
  if (bundled === null) {
    const path = fileURLToPath(new URL('../data/disposable-domains.txt', import.meta.url));
    bundled = new DomainSet(readFileSync(path, 'utf8').split('\n'));
  }
  return bundled;
}
