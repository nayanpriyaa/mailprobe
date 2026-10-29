import { useState, type FormEvent } from 'react';
import { API_BASE, signup } from '../api';
import { Button, CopyButton, ErrorNote, Field, inputClass } from '../components';

export function Welcome({ onKey, onDemo }: { onKey: (key: string) => void; onDemo: () => void }) {
  const [mode, setMode] = useState<'signup' | 'key'>('signup');
  const [email, setEmail] = useState('');
  const [key, setKey] = useState('');
  const [issued, setIssued] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    if (mode === 'key') {
      if (!/^mp_live_[0-9A-Za-z]{32}$/.test(key.trim())) return setError(new Error('That doesn’t look like a Mailprobe key. Keys start with mp_live_.'));
      return onKey(key.trim());
    }
    setBusy(true);
    try {
      const res = await signup(email);
      setIssued(res.api_key);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="mx-auto grid min-h-dvh max-w-6xl items-center gap-12 px-4 py-12 sm:px-6 lg:grid-cols-[1.1fr_1fr]">
      <section>
        <p className="mb-6 flex items-center gap-2 text-lg font-bold">
          <Logo /> Mailprobe
        </p>
        <h1 className="max-w-[16ch] text-4xl leading-[1.1] font-bold tracking-tight sm:text-5xl">
          Know which addresses will bounce before you hit send.
        </h1>
        <p className="mt-5 max-w-[52ch] text-lg leading-relaxed text-muted">
          Upload a list and every address is checked against its mail server, without sending anything. You get
          back four piles: send, drop, think twice, and couldn’t tell.
        </p>
        <SortingPreview />
      </section>

      <section className="rounded-xl bg-surface p-6 ring-1 ring-line sm:p-8">
        {issued ? (
          <div className="space-y-4">
            <h2 className="text-xl font-semibold">Your API key</h2>
            <p className="text-muted">This is the only time it’s shown. Store it somewhere safe; you’ll use it here and in API calls.</p>
            <div className="flex gap-2">
              <code className="flex-1 truncate rounded-md bg-paper px-3 py-2.5 text-sm">{issued}</code>
              <CopyButton text={issued} />
            </div>
            <Button className="w-full" onClick={() => onKey(issued)}>
              Continue to dashboard
            </Button>
          </div>
        ) : (
          <form onSubmit={submit} className="space-y-5">
            <div className="flex rounded-md bg-paper p-1 text-sm font-medium" role="tablist">
              {(['signup', 'key'] as const).map((m) => (
                <button
                  key={m}
                  type="button"
                  role="tab"
                  aria-selected={mode === m}
                  onClick={() => {
                    setMode(m);
                    setError(null);
                  }}
                  className={`flex-1 rounded px-3 py-2 ${mode === m ? 'bg-surface shadow-sm ring-1 ring-line' : 'text-muted'}`}
                >
                  {m === 'signup' ? 'Create account' : 'I have a key'}
                </button>
              ))}
            </div>

            {mode === 'signup' ? (
              <Field label="Work email" hint="You start with 1,000 free checks.">
                <input className={inputClass} type="email" required autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@company.com" />
              </Field>
            ) : (
              <Field label="API key">
                <input className={inputClass} required autoComplete="off" spellCheck={false} value={key} onChange={(e) => setKey(e.target.value)} placeholder="mp_live_…" />
              </Field>
            )}
            <ErrorNote error={error} />
            <Button className="w-full" busy={busy} type="submit">
              {mode === 'signup' ? 'Create account' : 'Open dashboard'}
            </Button>
            <p className="text-center text-sm text-muted">
              Just looking?{' '}
              <button type="button" onClick={onDemo} className="font-semibold text-brand underline underline-offset-4">
                Explore with sample data
              </button>
            </p>
            <p className="text-center text-xs text-muted">API: {API_BASE}</p>
          </form>
        )}
      </section>
    </main>
  );
}

function SortingPreview() {
  const rows = [
    ['priya.nair@acme.com', 'ok', 'Mailbox accepted'],
    ['old.lund@globex.io', 'bad', 'No such mailbox'],
    ['tomas@bigcorp.io', 'warn', 'Domain accepts every address'],
    ['jon.kim@gmial.com', 'bad', 'Did you mean gmail.com?'],
  ] as const;
  const bg = { ok: 'bg-ok', bad: 'bg-bad', warn: 'bg-warn' };
  return (
    <ul className="mt-10 max-w-md space-y-2 text-sm" aria-label="Example results">
      {rows.map(([email, tone, why]) => (
        <li key={email} className="flex items-center gap-3 rounded-md bg-surface/70 px-3 py-2 ring-1 ring-line">
          <span aria-hidden className={`size-2.5 rounded-full ${bg[tone]}`} />
          <span className="flex-1 truncate font-medium">{email}</span>
          <span className="text-muted">{why}</span>
        </li>
      ))}
    </ul>
  );
}

export function Logo() {
  return (
    <svg viewBox="0 0 32 32" className="size-7" aria-hidden>
      <rect width="32" height="32" rx="7" className="fill-brand" />
      <path d="M7 11h18v11H7z M7 11l9 7 9-7" fill="none" className="stroke-brand-ink" strokeWidth="2" strokeLinejoin="round" />
    </svg>
  );
}
