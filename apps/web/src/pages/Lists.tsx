import { useCallback, useEffect, useRef, useState } from 'react';
import type { Api, Job } from '../api';
import { ErrorNote, SortingBar, Spinner, usePoll } from '../components';
import { ago, num } from '../format';
import { navigate } from '../router';

const MAX_BYTES = 10 * 1024 * 1024;

export function Lists({ api, onCreditsChanged }: { api: Api; onCreditsChanged: () => void }) {
  const [jobs, setJobs] = useState<Job[] | null>(null);
  const [error, setError] = useState<unknown>(null);

  const load = useCallback(() => {
    api.listJobs().then((p) => setJobs(p.data), setError);
  }, [api]);
  useEffect(load, [load]);
  usePoll(load, 2000, !!jobs?.some((j) => j.status !== 'completed'));

  return (
    <div className="space-y-10">
      <Upload
        api={api}
        onCreated={(job) => {
          onCreditsChanged();
          navigate(`/jobs/${job.id}`);
        }}
      />

      <section>
        <h2 className="mb-3 text-lg font-semibold">Your lists</h2>
        <ErrorNote error={error} />
        {jobs === null && !error ? <p className="text-muted">Loading…</p> : null}
        {jobs?.length === 0 ? <p className="text-muted">Nothing checked yet. Your uploads will show up here.</p> : null}
        {jobs && jobs.length > 0 ? (
          <ul className="divide-y divide-line overflow-hidden rounded-lg bg-surface ring-1 ring-line">
            {jobs.map((j) => (
              <li key={j.id}>
                <a href={`#/jobs/${j.id}`} className="grid gap-x-6 gap-y-2 px-4 py-4 hover:bg-paper/60 sm:grid-cols-[minmax(0,1fr)_14rem_6rem]">
                  <span className="min-w-0">
                    <span className="block truncate font-medium">{j.name ?? 'Untitled list'}</span>
                    <span className="text-sm text-muted">
                      {j.status === 'completed'
                        ? `${num(j.total)} addresses, ${ago(j.completed_at)}`
                        : `${num(j.processed)} of ${num(j.total)} checked`}
                    </span>
                  </span>
                  <span className="self-center">
                    <SortingBar job={j} size="sm" />
                  </span>
                  <span className="self-center text-sm text-muted sm:text-right">
                    {j.total > 0 ? `${Math.round((j.counts.deliverable / j.total) * 100)}% good` : ''}
                  </span>
                </a>
              </li>
            ))}
          </ul>
        ) : null}
      </section>
    </div>
  );
}

function Upload({ api, onCreated }: { api: Api; onCreated: (job: Job) => void }) {
  const input = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const send = async (file: File) => {
    setError(null);
    if (file.size > MAX_BYTES) return setError(new Error('That file is over 10 MB. Split it into smaller lists.'));
    setBusy(true);
    try {
      onCreated(await api.createJobFromCsv(await file.text(), file.name));
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section>
      <h1 className="mb-1 text-2xl font-bold tracking-tight">Check a list</h1>
      <p className="mb-5 text-muted">Duplicates are removed before you’re charged. One check costs one credit.</p>
      <div
        onDragOver={(e) => {
          e.preventDefault();
          setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setOver(false);
          const file = e.dataTransfer.files[0];
          if (file) void send(file);
        }}
        className={`flex flex-col items-center gap-3 rounded-xl border-2 border-dashed px-6 py-12 text-center transition ${
          over ? 'border-brand bg-brand/5' : 'border-line bg-surface'
        }`}
      >
        {busy ? (
          <p className="flex items-center gap-2 font-medium">
            <Spinner /> Uploading…
          </p>
        ) : (
          <>
            <p className="text-lg font-semibold">Drop a CSV here</p>
            <p className="max-w-[46ch] text-sm text-muted">
              We find the email column for you: one headed “email”, or the one full of @ signs. Up to 50,000 rows.
            </p>
            <button
              type="button"
              onClick={() => input.current?.click()}
              className="mt-1 rounded-md px-3 py-1.5 font-semibold text-brand underline underline-offset-4"
            >
              Choose a file
            </button>
          </>
        )}
        <input
          ref={input}
          type="file"
          accept=".csv,text/csv,text/plain"
          className="sr-only"
          onChange={(e) => {
            const file = e.target.files?.[0];
            e.target.value = '';
            if (file) void send(file);
          }}
        />
      </div>
      <div className="mt-3">
        <ErrorNote error={error} />
      </div>
    </section>
  );
}
