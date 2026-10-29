import { useState } from 'react';
import type { Api, Verification } from '../api';
import { Button, Dot, ErrorNote, inputClass } from '../components';
import { STATUS_HELP, STATUS_LABEL, STATUS_TEXT, reasonLabel } from '../format';

type StepState = 'pass' | 'fail' | 'skip';

/** The checks run in this order and stop at the first failure, so they read as a sequence. */
function steps(v: Verification): Array<{ name: string; state: StepState; detail: string }> {
  const syntaxOk = v.reason !== 'invalid_syntax';
  const dnsFail = ['no_mx', 'null_mx', 'dns_error'].includes(v.reason);
  const dnsOk = syntaxOk && !dnsFail && v.reason !== 'disposable';
  const smtpRan = dnsOk && v.reason !== 'smtp_disabled';
  return [
    { name: 'Address format', state: syntaxOk ? 'pass' : 'fail', detail: syntaxOk ? 'Well-formed' : `Invalid (${v.syntax_error ?? 'syntax'})` },
    {
      name: 'Domain',
      state: !syntaxOk ? 'skip' : v.disposable || v.suggestion ? 'fail' : 'pass',
      detail: !syntaxOk
        ? 'Not checked'
        : v.disposable
          ? 'Throwaway inbox provider'
          : v.suggestion
            ? `Looks like a typo of ${v.suggestion}`
            : v.free
              ? 'Free consumer provider'
              : 'Not a free or throwaway provider',
    },
    {
      name: 'Mail server',
      state: !syntaxOk || v.disposable ? 'skip' : dnsFail ? 'fail' : 'pass',
      detail: !syntaxOk || v.disposable ? 'Not checked' : dnsFail ? reasonLabel(v.reason) : (v.mx_host ?? 'Found'),
    },
    {
      name: 'Mailbox',
      state: !smtpRan ? 'skip' : v.status === 'deliverable' ? 'pass' : v.status === 'undeliverable' ? 'fail' : 'skip',
      detail: !smtpRan ? 'Not checked' : `${reasonLabel(v.reason)}${v.smtp_code ? ` (${v.smtp_code})` : ''}`,
    },
  ];
}

const MARK: Record<StepState, string> = { pass: '✓', fail: '✕', skip: '–' };
const MARK_CLASS: Record<StepState, string> = { pass: 'bg-ok text-surface', fail: 'bg-bad text-surface', skip: 'bg-pending text-muted' };

export function QuickCheck({ api, onCreditsChanged }: { api: Api; onCreditsChanged: () => void }) {
  const [email, setEmail] = useState('');
  const [result, setResult] = useState<Verification | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const run = async (target = email) => {
    setBusy(true);
    setError(null);
    try {
      setResult(await api.verify(target));
      onCreditsChanged();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="max-w-2xl space-y-6">
      <div>
        <h1 className="mb-1 text-2xl font-bold tracking-tight">Check one address</h1>
        <p className="text-muted">Usually takes a second or two. Uses one credit.</p>
      </div>
      <form
        className="flex flex-col gap-3 sm:flex-row"
        onSubmit={(e) => {
          e.preventDefault();
          void run();
        }}
      >
        <input className={inputClass} required value={email} onChange={(e) => setEmail(e.target.value)} placeholder="jane.doe@company.com" aria-label="Email address" spellCheck={false} autoComplete="off" />
        <Button type="submit" busy={busy} className="h-11 shrink-0">
          Check address
        </Button>
      </form>
      <ErrorNote error={error} />

      {result ? (
        <section className="rounded-xl bg-surface p-5 ring-1 ring-line sm:p-6" aria-live="polite">
          <p className="truncate text-sm text-muted">{result.email}</p>
          <p className={`mt-1 flex items-center gap-2 text-2xl font-bold ${STATUS_TEXT[result.status]}`}>
            <Dot status={result.status} />
            {STATUS_LABEL[result.status]}
          </p>
          <p className="mt-1 text-muted">{STATUS_HELP[result.status]}</p>

          {result.suggestion ? (
            <p className="mt-4 rounded-md bg-paper px-3 py-2">
              Did you mean{' '}
              <button
                type="button"
                className="font-semibold text-brand underline underline-offset-4"
                onClick={() => {
                  const fixed = `${result.email.split('@')[0]}@${result.suggestion}`;
                  setEmail(fixed);
                  void run(fixed);
                }}
              >
                {result.email.split('@')[0]}@{result.suggestion}
              </button>
              ?
            </p>
          ) : null}

          <ol className="mt-6 space-y-3">
            {steps(result).map((s) => (
              <li key={s.name} className="flex items-start gap-3">
                <span aria-hidden className={`mt-0.5 grid size-5 shrink-0 place-items-center rounded-full text-xs font-bold ${MARK_CLASS[s.state]}`}>
                  {MARK[s.state]}
                </span>
                <span className="flex-1">
                  <span className="font-medium">{s.name}</span>
                  <span className="block text-sm text-muted">{s.detail}</span>
                </span>
              </li>
            ))}
          </ol>

          <dl className="mt-6 grid grid-cols-2 gap-4 border-t border-line pt-4 text-sm sm:grid-cols-4">
            <Fact label="Score" value={String(result.score)} />
            <Fact label="Role address" value={result.role ? 'Yes' : 'No'} />
            <Fact label="Catch-all" value={result.catch_all === null ? 'Unknown' : result.catch_all ? 'Yes' : 'No'} />
            <Fact label="Free provider" value={result.free ? 'Yes' : 'No'} />
          </dl>
        </section>
      ) : null}
    </div>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-muted">{label}</dt>
      <dd className="font-semibold">{value}</dd>
    </div>
  );
}
