import { Resolver } from 'node:dns/promises';

export interface MxHost {
  exchange: string;
  priority: number;
}

/**
 * Outcome of an MX lookup.
 *  - `mx`:      hosts sorted by preference. `implicit` means there was no MX record and
 *               the domain's own A/AAAA record is used (RFC 5321 section 5.1).
 *  - `null_mx`: the domain publishes "MX 0 ." and explicitly accepts no mail (RFC 7505).
 *  - `none`:    NXDOMAIN, or no MX and no address records. Definitive.
 *  - `error`:   timeout / SERVFAIL / refused. Temporary, so never cached long and retryable.
 */
export type MxLookup =
  | { kind: 'mx'; hosts: MxHost[]; implicit: boolean }
  | { kind: 'null_mx' }
  | { kind: 'none' }
  | { kind: 'error'; code: string };

export interface MxResolver {
  lookup(domain: string): Promise<MxLookup>;
}

/** The subset of node:dns/promises used here; injectable for tests. */
export interface DnsBackend {
  resolveMx(domain: string): Promise<{ exchange: string; priority: number }[]>;
  resolve4(domain: string): Promise<string[]>;
  resolve6(domain: string): Promise<string[]>;
}

export interface SystemDnsOptions {
  /** Per-query timeout in ms (c-ares). */
  timeoutMs?: number;
  tries?: number;
  /** Optional upstream servers, e.g. ['1.1.1.1', '8.8.8.8']. */
  servers?: string[];
}

export function systemDnsBackend(opts: SystemDnsOptions = {}): DnsBackend {
  const resolver = new Resolver({ timeout: opts.timeoutMs ?? 3000, tries: opts.tries ?? 2 });
  if (opts.servers && opts.servers.length > 0) resolver.setServers(opts.servers);
  return {
    resolveMx: (d) => resolver.resolveMx(d),
    resolve4: (d) => resolver.resolve4(d),
    resolve6: (d) => resolver.resolve6(d),
  };
}

// c-ares codes that mean "the answer is definitively empty".
const DEFINITIVE_EMPTY = new Set(['ENODATA', 'ENOTFOUND']);

function errorCode(err: unknown): string {
  const code = (err as { code?: unknown }).code;
  return typeof code === 'string' ? code : 'EUNKNOWN';
}

const stripDot = (host: string): string => host.toLowerCase().replace(/\.$/, '');

export class DnsMxResolver implements MxResolver {
  constructor(private readonly backend: DnsBackend = systemDnsBackend()) {}

  async lookup(domain: string): Promise<MxLookup> {
    try {
      const records = await this.backend.resolveMx(domain);
      if (records.length === 1 && stripDot(records[0]!.exchange) === '' && records[0]!.priority === 0) {
        return { kind: 'null_mx' };
      }
      const hosts = records
        .map((r) => ({ exchange: stripDot(r.exchange), priority: r.priority }))
        .filter((r) => r.exchange.length > 0)
        .sort((a, b) => a.priority - b.priority || a.exchange.localeCompare(b.exchange));
      if (hosts.length > 0) return { kind: 'mx', hosts, implicit: false };
    } catch (err) {
      const code = errorCode(err);
      if (code === 'ENOTFOUND') return { kind: 'none' }; // NXDOMAIN: no point asking for A records
      if (!DEFINITIVE_EMPTY.has(code)) return { kind: 'error', code };
    }
    return this.implicitMx(domain);
  }

  /** RFC 5321 5.1: with no MX records, the domain itself is the mail host if it has an address. */
  private async implicitMx(domain: string): Promise<MxLookup> {
    for (const resolve of [this.backend.resolve4, this.backend.resolve6]) {
      try {
        const addrs = await resolve.call(this.backend, domain);
        if (addrs.length > 0) return { kind: 'mx', hosts: [{ exchange: domain, priority: 0 }], implicit: true };
      } catch (err) {
        const code = errorCode(err);
        if (!DEFINITIVE_EMPTY.has(code)) return { kind: 'error', code };
      }
    }
    return { kind: 'none' };
  }
}

/**
 * Fixture-driven resolver for tests, local demos and benchmarks, where real DNS is
 * either unavailable or would make results non-deterministic. The `*` key, if
 * present, answers for every domain not listed explicitly.
 */
export class StaticMxResolver implements MxResolver {
  private readonly table: Map<string, MxLookup>;

  constructor(fixtures: Record<string, MxLookup>) {
    this.table = new Map(Object.entries(fixtures).map(([k, v]) => [k.toLowerCase(), v]));
  }

  async lookup(domain: string): Promise<MxLookup> {
    return this.table.get(domain.toLowerCase()) ?? this.table.get('*') ?? { kind: 'none' };
  }
}
