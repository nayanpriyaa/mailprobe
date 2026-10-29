import { useEffect, useRef, useState, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { STATUSES, type Job, type Status } from './api';
import { STATUS_BG, STATUS_LABEL, num } from './format';

/**
 * The sorting bar: one segment per verdict, proportional to its count, plus the
 * unchecked remainder. It is the job's progress bar and its summary at once.
 */
export function SortingBar({ job, size = 'lg' }: { job: Pick<Job, 'counts' | 'total' | 'processed'>; size?: 'lg' | 'sm' }) {
  const total = Math.max(1, job.total);
  const pending = Math.max(0, job.total - job.processed);
  const label = STATUSES.map((s) => `${STATUS_LABEL[s]} ${job.counts[s]}`).join(', ') + (pending ? `, ${pending} still checking` : '');
  return (
    <div
      role="img"
      aria-label={label}
      className={`flex w-full overflow-hidden ${size === 'lg' ? 'h-5 rounded-md' : 'h-2 rounded-sm'} bg-pending`}
    >
      {STATUSES.map((s) =>
        job.counts[s] > 0 ? (
          <div
            key={s}
            className={`${STATUS_BG[s]} h-full transition-[width] duration-700 ease-out [&+&]:border-l-2 [&+&]:border-surface`}
            style={{ width: `${(job.counts[s] / total) * 100}%` }}
          />
        ) : null,
      )}
    </div>
  );
}

export function Dot({ status }: { status: Status | 'pending' }) {
  return <span aria-hidden className={`inline-block size-2.5 shrink-0 rounded-full ${STATUS_BG[status]}`} />;
}

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'primary' | 'quiet' | 'danger'; busy?: boolean };

export function Button({ variant = 'primary', busy, className = '', children, disabled, ...rest }: ButtonProps) {
  const look = {
    primary: 'bg-brand text-brand-ink hover:brightness-110',
    quiet: 'bg-surface text-ink ring-1 ring-line hover:ring-muted',
    danger: 'bg-surface text-bad ring-1 ring-line hover:ring-bad',
  }[variant];
  return (
    <button
      {...rest}
      disabled={disabled || busy}
      className={`inline-flex h-10 items-center justify-center gap-2 rounded-md px-4 text-sm font-semibold transition disabled:cursor-not-allowed disabled:opacity-60 ${look} ${className}`}
    >
      {busy ? <Spinner /> : null}
      {children}
    </button>
  );
}

export function Spinner() {
  return <span aria-hidden className="size-4 animate-spin rounded-full border-2 border-current border-r-transparent" />;
}

export function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-sm font-medium">{label}</span>
      {children}
      {hint ? <span className="mt-1.5 block text-sm text-muted">{hint}</span> : null}
    </label>
  );
}

export const inputClass =
  'h-11 w-full rounded-md bg-surface px-3 text-base ring-1 ring-line placeholder:text-muted focus:outline-none focus:ring-2 focus:ring-brand';

export function ErrorNote({ error }: { error: unknown }) {
  if (!error) return null;
  const message = error instanceof Error ? error.message : String(error);
  return (
    <p role="alert" className="rounded-md bg-bad/10 px-3 py-2 text-sm text-bad">
      {message}
    </p>
  );
}

/** Polls `fn` every `ms` while `active`; stops on unmount. */
export function usePoll(fn: () => void, ms: number, active: boolean) {
  const saved = useRef(fn);
  saved.current = fn;
  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => saved.current(), ms);
    return () => clearInterval(id);
  }, [ms, active]);
}

export function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <Button
      variant="quiet"
      type="button"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        } catch {
          // clipboard unavailable (insecure context); the key is still selectable
        }
      }}
    >
      {copied ? 'Copied' : 'Copy'}
    </Button>
  );
}

export function Counts({ job, onPick, active }: { job: Pick<Job, 'counts'>; onPick?: (s: Status | undefined) => void; active?: Status | undefined }) {
  return (
    <div className="grid grid-cols-2 gap-x-6 gap-y-3 sm:flex sm:flex-wrap">
      {STATUSES.map((s) => {
        const content = (
          <>
            <span className="flex items-center gap-2 text-sm text-muted">
              <Dot status={s} />
              {STATUS_LABEL[s]}
            </span>
            <span className="text-2xl font-semibold">{num(job.counts[s])}</span>
          </>
        );
        if (!onPick) return <div key={s} className="flex flex-col">{content}</div>;
        const selected = active === s;
        return (
          <button
            key={s}
            type="button"
            aria-pressed={selected}
            onClick={() => onPick(selected ? undefined : s)}
            className={`-mx-2 flex flex-col items-start rounded-md px-2 py-1 text-left transition ${selected ? 'bg-surface ring-2 ring-ink' : 'hover:bg-surface'}`}
          >
            {content}
          </button>
        );
      })}
    </div>
  );
}
