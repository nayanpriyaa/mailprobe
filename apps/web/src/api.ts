export type Status = 'deliverable' | 'undeliverable' | 'risky' | 'unknown';
export const STATUSES: Status[] = ['deliverable', 'undeliverable', 'risky', 'unknown'];

export interface Account {
  email: string;
  name: string | null;
  credits: number;
  created_at: string;
}

export interface ApiKey {
  id: number;
  name: string;
  prefix: string;
  last_used_at: string | null;
  revoked_at: string | null;
  created_at: string;
  current: boolean;
}

export interface Job {
  id: string;
  name: string | null;
  status: 'queued' | 'processing' | 'completed' | 'failed';
  total: number;
  processed: number;
  progress: number;
  counts: Record<Status, number>;
  duplicates_removed: number;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
}

export interface ResultRow {
  email: string;
  state: 'pending' | 'retry' | 'done';
  status: Status | null;
  reason: string | null;
  score: number | null;
  disposable: boolean;
  role: boolean;
  free: boolean;
  catch_all: boolean | null;
  mx_host: string | null;
  smtp_code: number | null;
  suggestion: string | null;
  attempts: number;
  verified_at: string | null;
}

export interface Verification {
  email: string;
  status: Status;
  reason: string;
  score: number;
  syntax_error: string | null;
  disposable: boolean;
  role: boolean;
  free: boolean;
  catch_all: boolean | null;
  mx_host: string | null;
  smtp_code: number | null;
  smtp_message: string | null;
  suggestion: string | null;
}

export interface Page<T> {
  data: T[];
  next_cursor: string | null;
}

export interface Api {
  readonly demo: boolean;
  me(): Promise<Account>;
  verify(email: string): Promise<Verification>;
  createJobFromCsv(csv: string, name: string): Promise<Job>;
  listJobs(cursor?: string): Promise<Page<Job>>;
  getJob(id: string): Promise<Job>;
  results(id: string, opts: { status?: Status | undefined; cursor?: string | undefined }): Promise<Page<ResultRow>>;
  exportUrl(id: string, status?: Status): Promise<string>;
  listKeys(): Promise<ApiKey[]>;
  createKey(name: string): Promise<{ api_key: string }>;
  revokeKey(id: number): Promise<void>;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export const API_BASE = (import.meta.env.VITE_API_URL as string | undefined)?.replace(/\/$/, '') ?? 'http://localhost:4000';

async function request<T>(path: string, init: RequestInit & { key?: string } = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.key) headers.set('Authorization', `Bearer ${init.key}`);
  if (typeof init.body === 'string' && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
  let res: Response;
  try {
    res = await fetch(API_BASE + path, { ...init, headers });
  } catch {
    throw new ApiError(0, 'network', `Can't reach the API at ${API_BASE}. Check that it's running.`);
  }
  if (res.status === 204) return undefined as T;
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    const err = body?.error ?? {};
    throw new ApiError(res.status, err.code ?? 'error', err.message ?? `Request failed (${res.status})`);
  }
  return body as T;
}

export function signup(email: string, name?: string) {
  return request<{ account: Account; api_key: string }>('/v1/signup', {
    method: 'POST',
    body: JSON.stringify({ email, name: name || undefined }),
  });
}

export function httpApi(key: string): Api {
  const get = <T,>(path: string) => request<T>(path, { key });
  return {
    demo: false,
    me: () => get('/v1/me'),
    verify: (email) => request('/v1/verify', { method: 'POST', key, body: JSON.stringify({ email }) }),
    createJobFromCsv: (csv, name) =>
      request(`/v1/jobs?name=${encodeURIComponent(name)}`, {
        method: 'POST',
        key,
        body: csv,
        headers: { 'Content-Type': 'text/csv' },
      }),
    listJobs: (cursor) => get(`/v1/jobs?limit=20${cursor ? `&cursor=${cursor}` : ''}`),
    getJob: (id) => get(`/v1/jobs/${id}`),
    results: (id, { status, cursor }) => {
      const q = new URLSearchParams({ limit: '100' });
      if (status) q.set('status', status);
      if (cursor) q.set('cursor', cursor);
      return get(`/v1/jobs/${id}/results?${q}`);
    },
    // The export endpoint needs the Authorization header, so fetch it and hand back a blob URL.
    exportUrl: async (id, status) => {
      const res = await fetch(`${API_BASE}/v1/jobs/${id}/export.csv${status ? `?status=${status}` : ''}`, {
        headers: { Authorization: `Bearer ${key}` },
      });
      if (!res.ok) throw new ApiError(res.status, 'export_failed', 'Export failed. Try again.');
      return URL.createObjectURL(await res.blob());
    },
    listKeys: async () => (await get<{ data: ApiKey[] }>('/v1/keys')).data,
    createKey: (name) => request('/v1/keys', { method: 'POST', key, body: JSON.stringify({ name }) }),
    revokeKey: (id) => request(`/v1/keys/${id}`, { method: 'DELETE', key }),
  };
}
