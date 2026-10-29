import { createServer, type Server, type Socket } from 'node:net';
import type { AddressInfo } from 'node:net';

/**
 * Deterministic SMTP test double. Real MX hosts are unreachable from most dev
 * machines and CI (outbound port 25 is blocked), and would make tests flaky anyway.
 *
 * Mailbox behaviour is driven by the local part's prefix:
 *   bounce* / nouser*  -> 550 5.1.1 user unknown
 *   full*              -> 552 5.2.2 mailbox full
 *   grey*              -> 451 4.7.1 greylisted for the first `greylistTimes` attempts, then 250
 *   block*             -> 550 5.7.1 policy block
 *   <probePrefix>*     -> 550 5.1.1 (the verifier's catch-all probe), unless the domain is catch-all
 *   anything else      -> 250 2.1.5 OK
 */
export interface FakeSmtpOptions {
  host?: string;
  port?: number;
  /** Fixed delay, or [min, max] uniform jitter, before every reply. */
  latencyMs?: number | [number, number];
  catchAllDomains?: string[];
  probePrefix?: string;
  greylistTimes?: number;
  maxRecipients?: number;
  /** Greeting code; e.g. 421 to simulate an overloaded primary MX. */
  bannerCode?: number;
  rejectMailFrom?: boolean;
  /** Accept connections but never reply (timeout tests). */
  silent?: boolean;
}

export interface FakeSmtpStats {
  connections: number;
  activeConnections: number;
  maxConcurrentConnections: number;
  rcptCommands: number;
}

export class FakeSmtpServer {
  readonly stats: FakeSmtpStats = { connections: 0, activeConnections: 0, maxConcurrentConnections: 0, rcptCommands: 0 };
  private readonly server: Server;
  private readonly sockets = new Set<Socket>();
  private readonly greySeen = new Map<string, number>();
  private readonly opts: Required<Omit<FakeSmtpOptions, 'latencyMs'>> & { latencyMs: number | [number, number] };

  constructor(options: FakeSmtpOptions = {}) {
    this.opts = {
      host: options.host ?? '127.0.0.1',
      port: options.port ?? 0,
      latencyMs: options.latencyMs ?? 0,
      catchAllDomains: (options.catchAllDomains ?? []).map((d) => d.toLowerCase()),
      probePrefix: options.probePrefix ?? 'mp-probe-',
      greylistTimes: options.greylistTimes ?? 1,
      maxRecipients: options.maxRecipients ?? 100,
      bannerCode: options.bannerCode ?? 220,
      rejectMailFrom: options.rejectMailFrom ?? false,
      silent: options.silent ?? false,
    };
    this.server = createServer((s) => this.onConnection(s));
  }

  async start(): Promise<number> {
    await new Promise<void>((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(this.opts.port, this.opts.host, () => resolve());
    });
    return (this.server.address() as AddressInfo).port;
  }

  async stop(): Promise<void> {
    for (const s of this.sockets) s.destroy();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  private delay(): Promise<void> {
    const l = this.opts.latencyMs;
    const ms = Array.isArray(l) ? l[0] + Math.random() * (l[1] - l[0]) : l;
    return ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve();
  }

  private onConnection(socket: Socket): void {
    this.sockets.add(socket);
    this.stats.connections++;
    this.stats.activeConnections++;
    this.stats.maxConcurrentConnections = Math.max(this.stats.maxConcurrentConnections, this.stats.activeConnections);
    // A session ends at QUIT (or disconnect, whichever is first). Counting at QUIT rather
    // than at TCP close keeps the concurrency stat exact: a polite client releases its
    // slot only after the 221, i.e. after the server has already seen the QUIT.
    let active = true;
    const endSession = () => {
      if (!active) return;
      active = false;
      this.stats.activeConnections--;
    };
    socket.on('close', () => {
      this.sockets.delete(socket);
      endSession();
    });
    socket.on('error', () => socket.destroy());
    socket.setEncoding('latin1');
    if (this.opts.silent) return;

    let mailFrom = false;
    let rcpts = 0;
    let buffer = '';
    let chain = Promise.resolve(); // serialize replies even if commands are pipelined

    const reply = (text: string) => {
      chain = chain.then(async () => {
        await this.delay();
        if (!socket.destroyed) socket.write(text);
      });
      return chain;
    };

    const banner = this.opts.bannerCode;
    void reply(banner === 220 ? '220 fake-smtp.local ESMTP ready\r\n' : `${banner} 4.3.2 service temporarily unavailable\r\n`).then(
      () => banner !== 220 && socket.end(),
    );

    socket.on('data', (chunk: string) => {
      buffer += chunk;
      let nl: number;
      while ((nl = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, nl).replace(/\r$/, '');
        buffer = buffer.slice(nl + 1);
        const verb = line.slice(0, 4).toUpperCase();

        if (verb === 'EHLO') {
          void reply('250-fake-smtp.local greets you\r\n250-PIPELINING\r\n250-SIZE 35882577\r\n250 8BITMIME\r\n');
        } else if (verb === 'HELO') {
          void reply('250 fake-smtp.local\r\n');
        } else if (verb === 'MAIL') {
          if (this.opts.rejectMailFrom) {
            void reply('550 5.7.1 sender rejected by policy\r\n');
          } else {
            mailFrom = true;
            rcpts = 0;
            void reply('250 2.1.0 sender ok\r\n');
          }
        } else if (verb === 'RCPT') {
          this.stats.rcptCommands++;
          if (!mailFrom) {
            void reply('503 5.5.1 need MAIL first\r\n');
          } else if (++rcpts > this.opts.maxRecipients) {
            void reply('452 4.5.3 too many recipients\r\n');
          } else {
            void reply(this.rcptReply(line));
          }
        } else if (verb === 'RSET') {
          mailFrom = false;
          void reply('250 2.0.0 reset\r\n');
        } else if (verb === 'NOOP') {
          void reply('250 2.0.0 ok\r\n');
        } else if (verb === 'QUIT') {
          endSession();
          void reply('221 2.0.0 bye\r\n').then(() => socket.end());
        } else if (verb === 'DATA') {
          void reply('554 5.5.1 this server only verifies\r\n');
        } else {
          void reply('500 5.5.2 command not recognized\r\n');
        }
      }
    });
  }

  private rcptReply(line: string): string {
    const m = /<([^>]*)>/.exec(line);
    const addr = (m?.[1] ?? '').toLowerCase();
    const at = addr.lastIndexOf('@');
    const local = addr.slice(0, at);
    const domain = addr.slice(at + 1);

    if (this.opts.catchAllDomains.includes(domain)) return '250 2.1.5 ok\r\n';
    if (local.startsWith(this.opts.probePrefix)) return '550 5.1.1 user unknown\r\n';
    if (local.startsWith('bounce') || local.startsWith('nouser')) return '550 5.1.1 user unknown\r\n';
    if (local.startsWith('full')) return '552 5.2.2 mailbox full\r\n';
    if (local.startsWith('block')) return '550 5.7.1 blocked using zen.spamhaus.org\r\n';
    if (local.startsWith('grey')) {
      const seen = this.greySeen.get(addr) ?? 0;
      this.greySeen.set(addr, seen + 1);
      if (seen < this.opts.greylistTimes) return '451 4.7.1 greylisted, try again later\r\n';
    }
    return '250 2.1.5 recipient ok\r\n';
  }
}
