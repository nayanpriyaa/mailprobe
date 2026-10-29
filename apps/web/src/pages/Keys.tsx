import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { API_BASE, type Api, type ApiKey } from '../api';
import { Button, CopyButton, ErrorNote, Field, inputClass } from '../components';
import { ago } from '../format';

export function Keys({ api }: { api: Api }) {
  const [keys, setKeys] = useState<ApiKey[] | null>(null);
  const [name, setName] = useState('');
  const [issued, setIssued] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const load = useCallback(() => {
    api.listKeys().then(setKeys, setError);
  }, [api]);
  useEffect(load, [load]);

  const create = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      setIssued((await api.createKey(name)).api_key);
      setName('');
      load();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  const revoke = async (k: ApiKey) => {
    if (!window.confirm(`Revoke “${k.name}”? Anything using it stops working immediately.`)) return;
    setError(null);
    try {
      await api.revokeKey(k.id);
      load();
    } catch (err) {
      setError(err);
    }
  };

  return (
    <div className="max-w-3xl space-y-8">
      <div>
        <h1 className="mb-1 text-2xl font-bold tracking-tight">API keys</h1>
        <p className="text-muted">
          Use a separate key for each app or script, so you can revoke one without breaking the others. The API reference is at{' '}
          <a className="font-semibold text-brand underline underline-offset-4" href={`${API_BASE}/docs`} target="_blank" rel="noreferrer">
            {API_BASE.replace(/^https?:\/\//, '')}/docs
          </a>
          .
        </p>
      </div>

      <form onSubmit={create} className="flex flex-col gap-3 sm:flex-row sm:items-end">
        <div className="flex-1">
          <Field label="New key name">
            <input className={inputClass} required maxLength={80} value={name} onChange={(e) => setName(e.target.value)} placeholder="CRM sync" />
          </Field>
        </div>
        <Button type="submit" busy={busy} className="h-11">
          Create key
        </Button>
      </form>

      {issued ? (
        <div className="space-y-2 rounded-lg bg-surface p-4 ring-2 ring-brand">
          <p className="font-medium">Copy your new key now. It won’t be shown again.</p>
          <div className="flex gap-2">
            <code className="flex-1 truncate rounded-md bg-paper px-3 py-2.5 text-sm">{issued}</code>
            <CopyButton text={issued} />
          </div>
        </div>
      ) : null}

      <ErrorNote error={error} />

      <ul className="divide-y divide-line rounded-lg bg-surface ring-1 ring-line">
        {keys?.map((k) => (
          <li key={k.id} className="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-3">
            <span className="min-w-0 flex-1">
              <span className="font-medium">{k.name}</span>
              {k.current ? <span className="ml-2 text-sm text-muted">(this browser)</span> : null}
              <span className="block text-sm text-muted">
                {k.prefix}… {k.revoked_at ? `revoked ${ago(k.revoked_at)}` : k.last_used_at ? `last used ${ago(k.last_used_at)}` : 'never used'}
              </span>
            </span>
            {!k.revoked_at ? (
              <Button variant="danger" onClick={() => revoke(k)}>
                Revoke
              </Button>
            ) : null}
          </li>
        ))}
      </ul>
    </div>
  );
}
