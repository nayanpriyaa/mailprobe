import type { Status } from './api';

export const STATUS_LABEL: Record<Status, string> = {
  deliverable: 'Deliverable',
  undeliverable: 'Undeliverable',
  risky: 'Risky',
  unknown: 'Unknown',
};

/** Tailwind classes per verdict. Literal strings so the Tailwind scanner sees them. */
export const STATUS_BG: Record<Status | 'pending', string> = {
  deliverable: 'bg-ok',
  undeliverable: 'bg-bad',
  risky: 'bg-warn',
  unknown: 'bg-unk',
  pending: 'bg-pending',
};
export const STATUS_TEXT: Record<Status, string> = {
  deliverable: 'text-ok',
  undeliverable: 'text-bad',
  risky: 'text-warn',
  unknown: 'text-unk',
};

export const STATUS_HELP: Record<Status, string> = {
  deliverable: 'The mail server accepted the mailbox.',
  undeliverable: "Bad syntax, no mail server, or the mailbox doesn't exist.",
  risky: 'Exists, but sending is unwise: catch-all, disposable or full.',
  unknown: 'No clear answer after retries. The server blocked or ignored the check.',
};

/** Plain-language reason, as someone cleaning a list would say it. */
export const REASON_LABEL: Record<string, string> = {
  accepted: 'Mailbox accepted',
  invalid_syntax: 'Not a valid address',
  no_mx: 'Domain has no mail server',
  null_mx: 'Domain accepts no mail',
  mailbox_not_found: 'No such mailbox',
  rejected: 'Rejected by server',
  catch_all: 'Domain accepts every address',
  disposable: 'Throwaway inbox',
  mailbox_full: 'Mailbox full',
  greylisted: 'Server asked to retry later',
  throttled: 'Server rate-limited the check',
  smtp_blocked: 'Server blocked the check',
  smtp_unreachable: "Couldn't reach mail server",
  smtp_timeout: 'Mail server timed out',
  smtp_error: 'Mail server error',
  dns_error: 'DNS lookup failed',
  smtp_disabled: 'Mailbox not checked',
};

export const reasonLabel = (r: string | null) => (r ? (REASON_LABEL[r] ?? r) : 'Checking…');

const nf = new Intl.NumberFormat('en');
export const num = (n: number) => nf.format(n);

export function ago(iso: string | null): string {
  if (!iso) return '';
  const s = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 45) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  if (s < 86400 * 7) return `${Math.round(s / 86400)} d ago`;
  return new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}

export function duration(fromIso: string | null, toIso: string | null): string {
  if (!fromIso || !toIso) return '';
  const s = Math.max(0, Math.round((new Date(toIso).getTime() - new Date(fromIso).getTime()) / 1000));
  if (s < 60) return `${s} s`;
  if (s < 3600) return `${Math.floor(s / 60)} min ${s % 60} s`;
  return `${Math.floor(s / 3600)} h ${Math.floor((s % 3600) / 60)} min`;
}
