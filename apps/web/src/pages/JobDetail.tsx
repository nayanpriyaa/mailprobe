import { useCallback, useEffect, useState } from 'react';
import type { Api, Job, ResultRow, Status } from '../api';
import { Button, Counts, Dot, ErrorNote, SortingBar, usePoll } from '../components';
import { STATUS_HELP, STATUS_LABEL, STATUS_TEXT, ago, duration, num, reasonLabel } from '../format';

export function JobDetail({ api, id }: { api: Api; id: string }) {
  const [job, setJob] = useState<Job | null>(null);
  const [filter, setFilter] = useState<Status | undefined>(undefined);
  const [rows, setRows] = useState<ResultRow[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [exporting, setExporting] = useState(false);

  const running = job !== null && job.status !== 'completed';

  const loadJob = useCallback(() => {
    api.getJob(id).then(setJob, setError);
  }, [api, id]);

  const loadRows = useCallback(
    (append: string | null) => {
      api.results(id, { status: filter, cursor: append ?? undefined }).then((p) => {
        setRows((prev) => (append ? [...prev, ...p.data] : p.data));
        setCursor(p.next_cursor);
      }, setError);
    },
    [api, id, filter],
  );

  useEffect(loadJob, [loadJob]);
  useEffect(() => loadRows(null), [loadRows]);
  usePoll(
    () => {
      loadJob();
      loadRows(null);
    },
    1500,
    running,
  );
  // One last refresh of the rows when the job finishes.
  useEffect(() => {
    if (job?.status === 'completed') loadRows(null);
  }, [job?.status, loadRows]);

  const download = async () => {
    setExporting(true);
    try {
      const url = await api.exportUrl(id, filter);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${(job?.name ?? 'list').replace(/\.csv$/i, '')}-${filter ?? 'all'}.csv`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
    } catch (err) {
      setError(err);
    } finally {
      setExporting(false);
    }
  };

  if (!job) {
    return error ? <ErrorNote error={error} /> : <p className="text-muted">Loading…</p>;
  }

  const summary = running
    ? `${num(job.processed)} of ${num(job.total)} checked`
    : `${num(job.total)} addresses checked in ${duration(job.started_at ?? job.created_at, job.completed_at)}`;

  return (
    <div className="space-y-8">
      <div>
        <a href="#/lists" className="text-sm font-medium text-muted hover:text-ink">
          ← All lists
        </a>
        <div className="mt-2 flex flex-wrap items-end justify-between gap-4">
          <div className="min-w-0">
            <h1 className="truncate text-2xl font-bold tracking-tight">{job.name ?? 'Untitled list'}</h1>
            <p className="text-muted">
              {summary}
              {job.duplicates_removed > 0 ? `. ${num(job.duplicates_removed)} duplicates removed.` : '.'}
              {!running ? ` Finished ${ago(job.completed_at)}.` : ''}
            </p>
          </div>
          <Button variant={running ? 'quiet' : 'primary'} onClick={download} busy={exporting}>
            {filter ? `Download ${STATUS_LABEL[filter].toLowerCase()}` : 'Download all'} as CSV
          </Button>
        </div>
      </div>

      <section className="space-y-5 rounded-xl bg-surface p-5 ring-1 ring-line sm:p-6">
        <SortingBar job={job} />
        <Counts job={job} onPick={setFilter} active={filter} />
        <p className="min-h-5 text-sm text-muted">
          {filter ? STATUS_HELP[filter] : running ? 'Results appear as each mail server answers. You can leave this page.' : 'Pick a pile to see only those addresses.'}
        </p>
      </section>

      <ErrorNote error={error} />

      <section aria-label="Results">
        <ul className="divide-y divide-line rounded-lg bg-surface ring-1 ring-line sm:hidden">
          {rows.map((r) => (
            <li key={r.email} className="px-4 py-3 text-sm">
              <p className="truncate font-medium">
                {r.email}
                <Flags row={r} />
              </p>
              <p className="mt-1 flex items-center gap-2">
                <Dot status={r.status ?? 'pending'} />
                <span className={r.status ? STATUS_TEXT[r.status] : 'text-muted'}>{r.status ? STATUS_LABEL[r.status] : 'Checking'}</span>
                <span className="truncate text-muted">{reasonLabel(r.reason)}</span>
              </p>
              {r.suggestion ? <p className="mt-1">Did you mean {r.suggestion}?</p> : null}
            </li>
          ))}
        </ul>
        <div className="hidden overflow-x-auto rounded-lg bg-surface ring-1 ring-line sm:block">
          <table className="w-full min-w-[40rem] text-left text-sm">
            <thead className="border-b border-line text-muted">
              <tr>
                <th className="px-4 py-3 font-medium">Address</th>
                <th className="px-4 py-3 font-medium">Verdict</th>
                <th className="px-4 py-3 font-medium">Why</th>
                <th className="px-4 py-3 text-right font-medium">Score</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {rows.map((r) => (
                <tr key={r.email}>
                  <td className="max-w-[22rem] truncate px-4 py-2.5 font-medium">
                    {r.email}
                    <Flags row={r} />
                  </td>
                  <td className="px-4 py-2.5">
                    <span className="inline-flex items-center gap-2">
                      <Dot status={r.status ?? 'pending'} />
                      <span className={r.status ? STATUS_TEXT[r.status] : 'text-muted'}>
                        {r.status ? STATUS_LABEL[r.status] : r.state === 'retry' ? 'Retrying' : 'Checking'}
                      </span>
                    </span>
                  </td>
                  <td className="px-4 py-2.5 text-muted">
                    {reasonLabel(r.reason)}
                    {r.suggestion ? <span className="text-ink">. Did you mean {r.suggestion}?</span> : null}
                  </td>
                  <td className="px-4 py-2.5 text-right">{r.score ?? ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {rows.length === 0 ? (
          <p className="rounded-lg bg-surface px-4 py-10 text-center text-muted ring-1 ring-line">
            {filter ? `No ${STATUS_LABEL[filter].toLowerCase()} addresses in this list.` : 'No results yet.'}
          </p>
        ) : null}
        {cursor ? (
          <div className="mt-4 text-center">
            <Button variant="quiet" onClick={() => loadRows(cursor)}>
              Show more
            </Button>
          </div>
        ) : null}
      </section>
    </div>
  );
}

function Flags({ row }: { row: ResultRow }) {
  const flags = [row.role && 'role', row.free && 'free provider', row.disposable && 'throwaway'].filter(Boolean) as string[];
  if (flags.length === 0) return null;
  return (
    <span className="ml-2 inline-flex gap-1 align-middle">
      {flags.map((f) => (
        <span key={f} className="rounded bg-paper px-1.5 py-0.5 text-xs font-normal text-muted">
          {f}
        </span>
      ))}
    </span>
  );
}
