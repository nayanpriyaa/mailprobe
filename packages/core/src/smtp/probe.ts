import { randomBytes } from 'node:crypto';
import type { HostLimiter } from '../limiter.js';
import { SmtpConnection, SmtpFailure, type SmtpReply } from './connection.js';

export interface ProbeOptions {
  /** Name sent in EHLO. Must resolve back to the prober's IP in production or many MXs refuse. */
  heloName: string;
  /** Envelope sender for MAIL FROM. Use a real mailbox on a domain you control. */
  mailFrom: string;
  port: number;
  /**
   * Route every probe to this host instead of the real MX (dev/bench against the
   * fake SMTP server). Never set in production.
   */
  hostOverride?: string | undefined;
  connectTimeoutMs: number;
  commandTimeoutMs: number;
  /** Recipients per SMTP session. Most servers allow 100; staying lower avoids 452s. */
  maxRcptPerSession: number;
  /** Prefix for the random address used to detect catch-all domains. */
  catchAllProbePrefix: string;
}

export const DEFAULT_PROBE_OPTIONS: Omit<ProbeOptions, 'heloName' | 'mailFrom'> = {
  port: 25,
  connectTimeoutMs: 10_000,
  commandTimeoutMs: 15_000,
  maxRcptPerSession: 20,
  catchAllProbePrefix: 'mp-probe-',
};

export type SessionErrorKind =
  | SmtpFailure['kind']
  | 'banner_rejected'
  | 'helo_rejected'
  | 'mail_from_rejected'
  | 'throttled';

export type RcptOutcome =
  | { kind: 'reply'; reply: SmtpReply }
  | { kind: 'error'; error: SessionErrorKind; reply?: SmtpReply | undefined; detail?: string | undefined };

export interface DomainProbeResult {
  /** MX host that actually answered, if any. */
  mxHost: string | null;
  /** true/false when the random-address probe was conclusive, null otherwise. */
  catchAll: boolean | null;
  /**
   * Outcome per local part. Missing entries mean the domain was detected as
   * catch-all and the remaining recipients were intentionally not probed.
   */
  outcomes: Map<string, RcptOutcome>;
  sessions: number;
}

export interface ProbeDeps {
  limiter?: HostLimiter | undefined;
  /** Known catch-all status from cache; `false` skips the extra random RCPT. */
  knownCatchAll?: boolean | null | undefined;
}

class SessionAbort extends Error {
  constructor(
    readonly error: SessionErrorKind,
    readonly reply?: SmtpReply,
    readonly detail?: string,
  ) {
    super(error);
  }
}

const isPositive = (r: SmtpReply) => r.code >= 200 && r.code < 300;

/**
 * Probes all `locals` at `domain` using as few SMTP sessions as possible:
 * one session per `maxRcptPerSession` recipients, never sending DATA.
 *
 * When catch-all status is unknown, the first RCPT of the first session is a random
 * address. If the server accepts it, the domain accepts everything, per-mailbox
 * answers carry no information, and the remaining recipients are skipped.
 *
 * If the server answers "452 too many recipients" mid-session, the session limit is
 * lowered to what the server actually accepted and the rest carry over to a new session.
 */
export async function probeDomain(
  domain: string,
  mxHosts: readonly string[],
  locals: readonly string[],
  opts: ProbeOptions,
  deps: ProbeDeps = {},
): Promise<DomainProbeResult> {
  const result: DomainProbeResult = { mxHost: null, catchAll: deps.knownCatchAll ?? null, outcomes: new Map(), sessions: 0 };
  let pending = [...locals];
  let sessionLimit = Math.max(1, opts.maxRcptPerSession);
  let needCatchAllProbe = deps.knownCatchAll == null;

  while (pending.length > 0) {
    const slots = Math.max(1, sessionLimit - (needCatchAllProbe ? 1 : 0));
    const batch = pending.slice(0, slots);
    pending = pending.slice(batch.length);

    const probeLocal = needCatchAllProbe ? opts.catchAllProbePrefix + randomBytes(8).toString('hex') : null;
    const session = await runSession(domain, mxHosts, batch, probeLocal, opts, deps.limiter);
    result.sessions += session.connected ? 1 : 0;
    result.mxHost ??= session.mxHost;
    for (const [local, outcome] of session.outcomes) result.outcomes.set(local, outcome);

    if (probeLocal !== null && session.catchAll !== undefined) {
      result.catchAll = session.catchAll;
      // Only stop re-probing once the answer was conclusive.
      if (session.catchAll !== null) needCatchAllProbe = false;
    }
    if (result.catchAll === true) break; // remaining recipients carry no signal

    if (session.deferred.length > 0) {
      const accepted = session.rcptAnswered;
      if (accepted === 0) {
        // No progress at all: give up on these rather than loop.
        for (const l of session.deferred) result.outcomes.set(l, { kind: 'error', error: 'throttled', reply: session.deferReply });
      } else {
        sessionLimit = accepted; // learned server limit, includes the probe slot if one was used
        pending = [...session.deferred, ...pending];
      }
    }
  }
  return result;
}

interface SessionResult {
  connected: boolean;
  mxHost: string | null;
  /** undefined when the probe RCPT never ran (session failed before it). */
  catchAll: boolean | null | undefined;
  outcomes: Map<string, RcptOutcome>;
  /** Recipients not probed because the server hit its per-message recipient limit. */
  deferred: string[];
  deferReply?: SmtpReply | undefined;
  /** RCPT commands answered before the limit, including the catch-all probe. */
  rcptAnswered: number;
}

const isTooManyRecipients = (r: SmtpReply) =>
  r.code === 452 && (r.enhanced === '4.5.3' || /too many recipients/i.test(r.message));

async function runSession(
  domain: string,
  mxHosts: readonly string[],
  locals: readonly string[],
  probeLocal: string | null,
  opts: ProbeOptions,
  limiter: HostLimiter | undefined,
): Promise<SessionResult> {
  const outcomes = new Map<string, RcptOutcome>();
  const failAll = (o: RcptOutcome) => locals.forEach((l) => outcomes.has(l) || outcomes.set(l, o));
  let lastError: RcptOutcome = { kind: 'error', error: 'connect', detail: 'no MX hosts' };

  // Try MX hosts in preference order; fall through only on connection-level failures.
  for (const mx of mxHosts) {
    const target = opts.hostOverride ?? mx;
    // Limit by the real MX even when routed elsewhere, so dev/bench behave like production.
    const release = limiter ? await limiter.acquire(mx) : null;
    if (limiter && release === null) {
      lastError = { kind: 'error', error: 'throttled', detail: `no free slot for ${mx}` };
      continue;
    }

    let conn: SmtpConnection | null = null;
    try {
      conn = await SmtpConnection.open(target, opts.port, opts);
      const banner = await conn.read();
      if (banner.code !== 220) throw new SessionAbort('banner_rejected', banner);

      let helo = await conn.command(`EHLO ${opts.heloName}`);
      if (!isPositive(helo)) helo = await conn.command(`HELO ${opts.heloName}`);
      if (!isPositive(helo)) throw new SessionAbort('helo_rejected', helo);

      const mailFrom = await conn.command(`MAIL FROM:<${opts.mailFrom}>`);
      if (!isPositive(mailFrom)) throw new SessionAbort('mail_from_rejected', mailFrom);

      // Connected and accepted as a sender: from here on, errors are not fallthrough-worthy.
      let catchAll: boolean | null | undefined;
      let rcptAnswered = 0;
      const deferred: string[] = [];
      let deferReply: SmtpReply | undefined;
      try {
        if (probeLocal !== null) {
          const r = await conn.command(`RCPT TO:<${probeLocal}@${domain}>`);
          rcptAnswered++;
          catchAll = isPositive(r) ? true : r.code >= 500 ? false : null;
          if (catchAll === true) return { connected: true, mxHost: mx, catchAll, outcomes, deferred, rcptAnswered };
        }
        for (let i = 0; i < locals.length; i++) {
          const local = locals[i]!;
          const reply = await conn.command(`RCPT TO:<${local}@${domain}>`);
          if (isTooManyRecipients(reply)) {
            deferred.push(...locals.slice(i));
            deferReply = reply;
            break;
          }
          rcptAnswered++;
          outcomes.set(local, { kind: 'reply', reply });
        }
      } catch (err) {
        const f = err instanceof SmtpFailure ? err : new SmtpFailure('protocol', String(err));
        failAll({ kind: 'error', error: f.kind, detail: f.message });
      }
      return { connected: true, mxHost: mx, catchAll, outcomes, deferred, deferReply, rcptAnswered };
    } catch (err) {
      if (err instanceof SessionAbort) {
        lastError = { kind: 'error', error: err.error, reply: err.reply, detail: err.reply?.message };
        // A 4xx/5xx greeting or HELO refusal from the primary is worth trying the backup MX.
        if (err.error === 'banner_rejected') continue;
        failAll(lastError);
        return { connected: true, mxHost: mx, catchAll: undefined, outcomes, deferred: [], rcptAnswered: 0 };
      }
      const f = err instanceof SmtpFailure ? err : new SmtpFailure('protocol', String(err));
      lastError = { kind: 'error', error: f.kind, detail: f.message };
      // connect / timeout / reset before MAIL FROM: try the next MX.
    } finally {
      await conn?.close();
      await release?.();
    }
  }

  failAll(lastError);
  return { connected: false, mxHost: null, catchAll: undefined, outcomes, deferred: [], rcptAnswered: 0 };
}
