import { useEffect, useState } from 'react';

/**
 * Hash routing (#/lists, #/jobs/:id): works on any static host with no rewrite
 * rules, which is all this client-only dashboard needs.
 */
export type Route =
  | { name: 'lists' }
  | { name: 'job'; id: string }
  | { name: 'check' }
  | { name: 'keys' };

export function parseRoute(hash: string): Route {
  const path = hash.replace(/^#/, '') || '/lists';
  const job = /^\/jobs\/([0-9A-Za-z]{26})$/.exec(path);
  if (job) return { name: 'job', id: job[1]! };
  if (path === '/check') return { name: 'check' };
  if (path === '/keys') return { name: 'keys' };
  return { name: 'lists' };
}

export function navigate(path: string): void {
  window.location.hash = path;
}

export function useRoute(): Route {
  const [route, setRoute] = useState(() => parseRoute(window.location.hash));
  useEffect(() => {
    const onChange = () => {
      setRoute(parseRoute(window.location.hash));
      window.scrollTo(0, 0);
    };
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, []);
  return route;
}
