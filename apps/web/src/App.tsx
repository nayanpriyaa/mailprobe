import { useCallback, useEffect, useMemo, useState } from 'react';
import { httpApi, type Account, type Api } from './api';
import { demoApi } from './demo';
import { num } from './format';
import { JobDetail } from './pages/JobDetail';
import { Keys } from './pages/Keys';
import { Lists } from './pages/Lists';
import { QuickCheck } from './pages/QuickCheck';
import { Logo, Welcome } from './pages/Welcome';
import { useRoute, type Route } from './router';

const STORAGE_KEY = 'mailprobe.apiKey';
const DEMO = 'demo';

// Browser storage can be unavailable (private mode, blocked cookies): fall back to memory.
const storage = {
  get: () => {
    try {
      return localStorage.getItem(STORAGE_KEY);
    } catch {
      return null;
    }
  },
  set: (v: string | null) => {
    try {
      if (v === null) localStorage.removeItem(STORAGE_KEY);
      else localStorage.setItem(STORAGE_KEY, v);
    } catch {
      // ignore
    }
  },
};

export function App() {
  const [session, setSession] = useState<string | null>(() => storage.get());
  const api = useMemo<Api | null>(() => (session === null ? null : session === DEMO ? demoApi() : httpApi(session)), [session]);

  const start = (value: string) => {
    storage.set(value);
    setSession(value);
  };
  const signOut = () => {
    storage.set(null);
    setSession(null);
    window.location.hash = '';
  };

  if (!api) return <Welcome onKey={start} onDemo={() => start(DEMO)} />;
  return <Shell api={api} onSignOut={signOut} />;
}

const NAV: Array<{ route: Route['name']; href: string; label: string }> = [
  { route: 'lists', href: '#/lists', label: 'Lists' },
  { route: 'check', href: '#/check', label: 'Check one' },
  { route: 'keys', href: '#/keys', label: 'API keys' },
];

function Shell({ api, onSignOut }: { api: Api; onSignOut: () => void }) {
  const route = useRoute();
  const [account, setAccount] = useState<Account | null>(null);
  const [authError, setAuthError] = useState(false);

  const refreshAccount = useCallback(() => {
    api.me().then(setAccount, (err) => {
      if ((err as { status?: number }).status === 401) setAuthError(true);
    });
  }, [api]);
  useEffect(refreshAccount, [refreshAccount]);

  if (authError) {
    return (
      <main className="mx-auto max-w-md px-4 py-24">
        <h1 className="text-xl font-semibold">This API key no longer works</h1>
        <p className="mt-2 text-muted">It may have been revoked. Sign in again with another key.</p>
        <button onClick={onSignOut} className="mt-6 font-semibold text-brand underline underline-offset-4">
          Use a different key
        </button>
      </main>
    );
  }

  const active = route.name === 'job' ? 'lists' : route.name;

  return (
    <div className="min-h-dvh">
      {api.demo ? (
        <div className="bg-brand px-4 py-2 text-center text-sm text-brand-ink">
          Sample data, simulated in your browser. Nothing is sent to a mail server.{' '}
          <button onClick={onSignOut} className="font-semibold underline underline-offset-4">
            Leave demo
          </button>
        </div>
      ) : null}
      <header className="border-b border-line bg-surface">
        <div className="mx-auto flex h-16 max-w-6xl items-center gap-3 px-4 sm:gap-6 sm:px-6">
          <a href="#/lists" className="flex items-center gap-2 font-bold" aria-label="Mailprobe home">
            <Logo />
            <span className="hidden sm:inline">Mailprobe</span>
          </a>
          <nav className="flex gap-1 text-sm font-medium" aria-label="Main">
            {NAV.map((n) => (
              <a
                key={n.route}
                href={n.href}
                aria-current={active === n.route ? 'page' : undefined}
                className={`rounded-md px-2 py-2 whitespace-nowrap sm:px-3 ${active === n.route ? 'bg-paper text-ink' : 'text-muted hover:text-ink'}`}
              >
                {n.label}
              </a>
            ))}
          </nav>
          <div className="ml-auto flex items-center gap-4 text-sm">
            {account ? (
              <span className="hidden text-right md:block">
                <span className="block font-semibold">{num(account.credits)} credits</span>
                <span className="block text-muted">{account.email}</span>
              </span>
            ) : null}
            <button onClick={onSignOut} className="whitespace-nowrap text-muted hover:text-ink">
              Sign out
            </button>
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-6xl px-4 py-8 sm:px-6 sm:py-10">
        {route.name === 'lists' ? <Lists api={api} onCreditsChanged={refreshAccount} /> : null}
        {route.name === 'job' ? <JobDetail key={route.id} api={api} id={route.id} /> : null}
        {route.name === 'check' ? <QuickCheck api={api} onCreditsChanged={refreshAccount} /> : null}
        {route.name === 'keys' ? <Keys api={api} /> : null}
      </main>
    </div>
  );
}
