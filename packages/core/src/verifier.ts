import { classifyOutcome, score, type Verdict, type VerificationReason, type VerificationStatus } from './classify.js';
import { DomainSet, loadDisposableDomains } from './disposable.js';
import type { MxLookup, MxResolver } from './dns.js';
import type { HostLimiter } from './limiter.js';
import { FREE_PROVIDERS, ROLE_LOCALS } from './lists.js';
import { probeDomain, type ProbeOptions, type RcptOutcome } from './smtp/probe.js';
import { parseAddress, type SyntaxErrorCode } from './syntax.js';
import { suggestDomain } from './typo.js';
import { mapLimit, type VerifierCache } from './util.js';

export interface VerificationResult {
  /** Exactly what the caller passed in. */
  input: string;
  /** Normalized address, or null if the syntax was invalid. */
  email: string | null;
  domain: string | null;
  status: VerificationStatus;
  reason: VerificationReason;
  score: number;
  retryable: boolean;
  syntaxError: SyntaxErrorCode | null;
  disposable: boolean;
  role: boolean;
  free: boolean;
  catchAll: boolean | null;
  mxHost: string | null;
  smtpCode: number | null;
  smtpEnhanced: string | null;
  smtpMessage: string | null;
  /** Corrected domain if this one looks like a typo, e.g. gmial.com -> gmail.com. */
  suggestion: string | null;
}

export interface VerifierOptions {
  /** null disables SMTP probing; results then stop at the DNS layer with reason `smtp_disabled`. */
  smtp: ProbeOptions | null;
  /** Domains probed in parallel within one batch. */
  domainConcurrency: number;
  mxCacheTtlSec: number;
  /** Negative answers (no MX) are cached for less time in case DNS is mid-change. */
  negativeMxCacheTtlSec: number;
  catchAllCacheTtlSec: number;
}

export const DEFAULT_VERIFIER_OPTIONS: Omit<VerifierOptions, 'smtp'> = {
  domainConcurrency: 8,
  mxCacheTtlSec: 3600,
  negativeMxCacheTtlSec: 300,
  catchAllCacheTtlSec: 24 * 3600,
};

export interface VerifierDeps {
  resolver: MxResolver;
  cache?: VerifierCache | undefined;
  limiter?: HostLimiter | undefined;
  disposable?: DomainSet | undefined;
}

export interface VerifierMetrics {
  dnsLookups: number;
  mxCacheHits: number;
  catchAllCacheHits: number;
  smtpSessions: number;
  rcptSkippedCatchAll: number;
}

interface Target {
  local: string;
  domain: string;
  normalized: string;
}

/**
 * Orchestrates the checks, cheapest first: syntax -> disposable -> DNS -> SMTP.
 * Work is grouped by domain so a batch of 500 addresses at 40 domains costs 40 MX
 * lookups and roughly 40 SMTP sessions, not 500.
 */
export class Verifier {
  readonly metrics: VerifierMetrics = {
    dnsLookups: 0,
    mxCacheHits: 0,
    catchAllCacheHits: 0,
    smtpSessions: 0,
    rcptSkippedCatchAll: 0,
  };
  private readonly opts: VerifierOptions;
  private readonly disposable: DomainSet;

  constructor(
    private readonly deps: VerifierDeps,
    options: Partial<VerifierOptions> & Pick<VerifierOptions, 'smtp'>,
  ) {
    this.opts = { ...DEFAULT_VERIFIER_OPTIONS, ...options };
    this.disposable = deps.disposable ?? loadDisposableDomains();
  }

  async verify(input: string): Promise<VerificationResult> {
    const [r] = await this.verifyBatch([input]);
    return r!;
  }

  /** Returns one result per input, in input order. Duplicate addresses are probed once. */
  async verifyBatch(inputs: readonly string[]): Promise<VerificationResult[]> {
    const byNormalized = new Map<string, VerificationResult>();
    const byDomain = new Map<string, Target[]>();
    const seen = new Set<string>();
    const parsed = inputs.map((input) => {
      const p = parseAddress(input);
      if (p.ok && !seen.has(p.address.normalized)) {
        seen.add(p.address.normalized);
        const list = byDomain.get(p.address.domain) ?? [];
        list.push(p.address);
        byDomain.set(p.address.domain, list);
      }
      return p;
    });

    await mapLimit([...byDomain.entries()], this.opts.domainConcurrency, async ([domain, targets]) => {
      for (const r of await this.verifyDomain(domain, targets)) byNormalized.set(r.email!, r);
    });

    return parsed.map((p, i) => {
      const input = inputs[i]!;
      if (!p.ok) return invalidSyntax(input, p.error);
      return { ...byNormalized.get(p.address.normalized)!, input };
    });
  }

  private async verifyDomain(domain: string, targets: Target[]): Promise<VerificationResult[]> {
    const suggestion = suggestDomain(domain);
    const free = FREE_PROVIDERS.has(domain);
    const base = (t: Target): VerificationResult => ({
      input: t.normalized,
      email: t.normalized,
      domain,
      status: 'unknown',
      reason: 'smtp_error',
      score: 0,
      retryable: false,
      syntaxError: null,
      disposable: false,
      role: ROLE_LOCALS.has(t.local),
      free,
      catchAll: null,
      mxHost: null,
      smtpCode: null,
      smtpEnhanced: null,
      smtpMessage: null,
      suggestion,
    });
    const finish = (r: VerificationResult, verdict: Verdict): VerificationResult => {
      r.status = verdict.status;
      r.reason = verdict.reason;
      r.retryable = verdict.retryable;
      r.score = score(r);
      return r;
    };
    const all = (patch: Partial<VerificationResult>, verdict: Verdict) =>
      targets.map((t) => finish({ ...base(t), ...patch }, verdict));

    // 1. Disposable: no network needed; real but worthless for outreach.
    if (this.disposable.has(domain)) {
      return all({ disposable: true }, { status: 'risky', reason: 'disposable', retryable: false });
    }

    // 2. DNS.
    const mx = await this.lookupMx(domain);
    if (mx.kind === 'error') return all({}, { status: 'unknown', reason: 'dns_error', retryable: true });
    if (mx.kind === 'none') return all({}, { status: 'undeliverable', reason: 'no_mx', retryable: false });
    if (mx.kind === 'null_mx') return all({}, { status: 'undeliverable', reason: 'null_mx', retryable: false });
    const primary = mx.hosts[0]?.exchange ?? null;

    // 3. SMTP.
    if (this.opts.smtp === null) {
      return all({ mxHost: primary }, { status: 'unknown', reason: 'smtp_disabled', retryable: false });
    }

    const caKey = `ca:${domain}`;
    const knownCatchAll = this.deps.cache ? await this.deps.cache.get<boolean>(caKey) : undefined;
    if (knownCatchAll === true) {
      this.metrics.catchAllCacheHits++;
      this.metrics.rcptSkippedCatchAll += targets.length;
      return all({ mxHost: primary, catchAll: true }, { status: 'risky', reason: 'catch_all', retryable: false });
    }

    const probe = await probeDomain(
      domain,
      mx.hosts.map((h) => h.exchange),
      targets.map((t) => t.local),
      this.opts.smtp,
      { limiter: this.deps.limiter, knownCatchAll: knownCatchAll ?? null },
    );
    this.metrics.smtpSessions += probe.sessions;
    if (probe.catchAll !== null && knownCatchAll === undefined) {
      await this.deps.cache?.set(caKey, probe.catchAll, this.opts.catchAllCacheTtlSec);
    }

    return targets.map((t) => {
      const r = base(t);
      r.mxHost = probe.mxHost ?? primary;
      r.catchAll = probe.catchAll;
      const outcome: RcptOutcome | undefined = probe.outcomes.get(t.local);
      if (outcome === undefined) {
        // Skipped because the domain accepted a random address.
        this.metrics.rcptSkippedCatchAll++;
        return finish(r, { status: 'risky', reason: 'catch_all', retryable: false });
      }
      const reply = outcome.reply;
      if (reply) {
        r.smtpCode = reply.code;
        r.smtpEnhanced = reply.enhanced;
        r.smtpMessage = reply.message.slice(0, 500);
      }
      const verdict = classifyOutcome(outcome);
      if (verdict.status === 'deliverable' && probe.catchAll === true) {
        return finish(r, { status: 'risky', reason: 'catch_all', retryable: false });
      }
      return finish(r, verdict);
    });
  }

  private async lookupMx(domain: string): Promise<MxLookup> {
    const key = `mx:${domain}`;
    const cached = this.deps.cache ? await this.deps.cache.get<MxLookup>(key) : undefined;
    if (cached) {
      this.metrics.mxCacheHits++;
      return cached;
    }
    this.metrics.dnsLookups++;
    const result = await this.deps.resolver.lookup(domain);
    if (this.deps.cache && result.kind !== 'error') {
      const ttl = result.kind === 'mx' ? this.opts.mxCacheTtlSec : this.opts.negativeMxCacheTtlSec;
      await this.deps.cache.set(key, result, ttl);
    }
    return result;
  }
}

function invalidSyntax(input: string, error: SyntaxErrorCode): VerificationResult {
  return {
    input,
    email: null,
    domain: null,
    status: 'undeliverable',
    reason: 'invalid_syntax',
    score: 0,
    retryable: false,
    syntaxError: error,
    disposable: false,
    role: false,
    free: false,
    catchAll: null,
    mxHost: null,
    smtpCode: null,
    smtpEnhanced: null,
    smtpMessage: null,
    suggestion: null,
  };
}
