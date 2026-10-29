import type { SmtpReply } from './smtp/connection.js';
import type { RcptOutcome } from './smtp/probe.js';

export type VerificationStatus = 'deliverable' | 'undeliverable' | 'risky' | 'unknown';

export type VerificationReason =
  | 'accepted'
  | 'invalid_syntax'
  | 'no_mx'
  | 'null_mx'
  | 'mailbox_not_found'
  | 'rejected'
  | 'catch_all'
  | 'disposable'
  | 'mailbox_full'
  | 'greylisted'
  | 'throttled'
  | 'smtp_blocked'
  | 'smtp_unreachable'
  | 'smtp_timeout'
  | 'smtp_error'
  | 'dns_error'
  | 'smtp_disabled';

export interface Verdict {
  status: VerificationStatus;
  reason: VerificationReason;
  /** True if the same check may give a definitive answer later (greylisting, timeouts). */
  retryable: boolean;
}

const v = (status: VerificationStatus, reason: VerificationReason, retryable = false): Verdict => ({
  status,
  reason,
  retryable,
});

// Text heuristics for servers that omit enhanced status codes.
const NOT_FOUND_TEXT =
  /(user unknown|unknown user|no such (user|mailbox|recipient)|does ?n[o']t exist|mailbox (unavailable|not found)|recipient (not found|rejected|unknown)|invalid (recipient|mailbox|address)|address rejected|undeliverable address)/i;
const BLOCKED_TEXT =
  /(spam|block(ed|list)|blacklist|deny|denied|policy|reputation|spamhaus|barracuda|banned|rbl|not allowed to send|access denied)/i;
const FULL_TEXT = /(mailbox full|quota|over ?quota|insufficient storage|exceeded storage)/i;
const TOO_MANY_TEXT = /too many (recipients|connections|messages)|rate.?limit|throttl/i;
const GREYLIST_TEXT = /gr[ea]ylist/i;

/** Maps a RCPT TO reply to a verdict. Enhanced codes win over text when present. */
export function classifyRcptReply(r: SmtpReply): Verdict {
  const e = r.enhanced;
  if (r.code >= 200 && r.code < 300) return v('deliverable', 'accepted');

  if (r.code >= 400 && r.code < 500) {
    if (e === '4.2.2' || FULL_TEXT.test(r.message)) return v('risky', 'mailbox_full');
    if (GREYLIST_TEXT.test(r.message)) return v('unknown', 'greylisted', true);
    if (r.code === 452 || r.code === 421 || TOO_MANY_TEXT.test(r.message)) return v('unknown', 'throttled', true);
    return v('unknown', 'greylisted', true);
  }

  if (r.code >= 500) {
    if (e === '5.2.2' || (r.code === 552 && FULL_TEXT.test(r.message))) return v('risky', 'mailbox_full');
    if (e?.startsWith('5.1.')) return v('undeliverable', 'mailbox_not_found');
    // A policy block says nothing about the mailbox; it says the prober is not welcome.
    if (e?.startsWith('5.7.') || BLOCKED_TEXT.test(r.message)) return v('unknown', 'smtp_blocked');
    if (NOT_FOUND_TEXT.test(r.message)) return v('undeliverable', 'mailbox_not_found');
    if (r.code === 550 || r.code === 551 || r.code === 553) return v('undeliverable', 'mailbox_not_found');
    if (r.code === 554) return v('unknown', 'smtp_blocked');
    return v('undeliverable', 'rejected');
  }

  return v('unknown', 'smtp_error', true);
}

/** Maps any per-recipient probe outcome (reply or session error) to a verdict. */
export function classifyOutcome(o: RcptOutcome): Verdict {
  if (o.kind === 'reply') return classifyRcptReply(o.reply);

  switch (o.error) {
    case 'connect':
      return v('unknown', 'smtp_unreachable', true);
    case 'timeout':
      return v('unknown', 'smtp_timeout', true);
    case 'throttled':
      return v('unknown', 'throttled', true);
    case 'closed':
    case 'protocol':
      return v('unknown', 'smtp_error', true);
    case 'banner_rejected':
    case 'helo_rejected':
    case 'mail_from_rejected': {
      // 4xx at session level is usually rate limiting or greylisting of the sender.
      const temporary = o.reply !== undefined && o.reply.code >= 400 && o.reply.code < 500;
      return temporary ? v('unknown', 'throttled', true) : v('unknown', 'smtp_blocked');
    }
  }
}

export interface ScoreInput {
  status: VerificationStatus;
  reason: VerificationReason;
  role: boolean;
  free: boolean;
}

/**
 * 0-100 confidence that sending to this address is safe. A heuristic, not a model:
 * the point is a sortable column for list cleaning, with the inputs visible next to it.
 */
export function score({ status, reason, role }: ScoreInput): number {
  let s: number;
  switch (status) {
    case 'deliverable':
      s = 95;
      break;
    case 'undeliverable':
      return 0;
    case 'risky':
      s = reason === 'catch_all' ? 55 : reason === 'mailbox_full' ? 35 : 10;
      break;
    case 'unknown':
      s = reason === 'smtp_disabled' ? 50 : 30;
      break;
  }
  if (role) s -= 15;
  return Math.max(0, Math.min(100, s));
}
