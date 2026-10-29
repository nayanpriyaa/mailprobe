import type { VerificationResult } from '@mailprobe/core';
import type { JobRow, VerificationRow } from '@mailprobe/server';

/** API shapes. Internal numeric ids never leave the server; jobs are addressed by ULID. */

export function jobDto(j: JobRow) {
  return {
    id: j.public_id,
    name: j.name,
    status: j.status,
    total: j.total,
    processed: j.processed,
    progress: j.total === 0 ? 1 : Math.round((j.processed / j.total) * 1000) / 1000,
    counts: {
      deliverable: j.deliverable,
      undeliverable: j.undeliverable,
      risky: j.risky,
      unknown: j.unknown,
    },
    duplicates_removed: j.duplicates_removed,
    created_at: j.created_at,
    started_at: j.started_at,
    completed_at: j.completed_at,
  };
}

const flag = (v: number | null) => (v === null ? null : v === 1);

export function resultRowDto(r: VerificationRow) {
  return {
    email: r.email,
    state: r.state,
    status: r.status,
    reason: r.reason,
    score: r.score,
    disposable: flag(r.is_disposable),
    role: flag(r.is_role),
    free: flag(r.is_free),
    catch_all: flag(r.is_catch_all),
    mx_host: r.mx_host,
    smtp_code: r.smtp_code,
    suggestion: r.suggestion,
    attempts: r.attempts,
    verified_at: r.verified_at,
  };
}

export function verificationDto(r: VerificationResult) {
  return {
    email: r.email ?? r.input,
    status: r.status,
    reason: r.reason,
    score: r.score,
    syntax_error: r.syntaxError,
    disposable: r.disposable,
    role: r.role,
    free: r.free,
    catch_all: r.catchAll,
    mx_host: r.mxHost,
    smtp_code: r.smtpCode,
    smtp_message: r.smtpMessage,
    suggestion: r.suggestion,
  };
}

export const EXPORT_COLUMNS = [
  'email',
  'status',
  'reason',
  'score',
  'disposable',
  'role',
  'free',
  'catch_all',
  'mx_host',
  'smtp_code',
  'suggestion',
  'verified_at',
] as const;

export function exportRow(r: VerificationRow): unknown[] {
  const d = resultRowDto(r);
  return [
    d.email,
    d.status ?? d.state,
    d.reason,
    d.score,
    d.disposable,
    d.role,
    d.free,
    d.catch_all,
    d.mx_host,
    d.smtp_code,
    d.suggestion,
    d.verified_at?.toISOString() ?? null,
  ];
}
