import { Socket, connect } from 'node:net';

export interface SmtpReply {
  code: number;
  /** RFC 3463 enhanced status code from the first line, e.g. "5.1.1". */
  enhanced: string | null;
  /** All reply lines joined with "\n", status codes stripped. */
  message: string;
}

export type SmtpFailureKind = 'connect' | 'timeout' | 'closed' | 'protocol';

export class SmtpFailure extends Error {
  constructor(
    readonly kind: SmtpFailureKind,
    message: string,
    readonly code?: string,
  ) {
    super(message);
    this.name = 'SmtpFailure';
  }
}

export interface ConnectionOptions {
  connectTimeoutMs: number;
  commandTimeoutMs: number;
}

const MAX_BUFFER = 64 * 1024; // a well-behaved server never sends a reply this large
const ENHANCED = /^([245]\.\d{1,3}\.\d{1,3})(?:\s|$)/;

/**
 * Minimal SMTP client: just enough for EHLO / MAIL FROM / RCPT TO / QUIT.
 * Replies are parsed incrementally from the socket; multi-line replies
 * ("250-...\r\n250 ...") are assembled into one SmtpReply.
 */
export class SmtpConnection {
  private buffer = '';
  private pendingLines: string[] = [];
  private readonly replies: SmtpReply[] = [];
  private waiter: { resolve: (r: SmtpReply) => void; reject: (e: SmtpFailure) => void } | null = null;
  private failure: SmtpFailure | null = null;

  private constructor(
    private readonly socket: Socket,
    private readonly opts: ConnectionOptions,
  ) {
    socket.setEncoding('latin1'); // SMTP replies are 7-bit; never throw on stray bytes
    socket.setNoDelay(true);
    socket.on('data', (chunk: string) => this.onData(chunk));
    socket.on('error', (err: NodeJS.ErrnoException) =>
      this.fail(new SmtpFailure('closed', err.message, err.code)),
    );
    socket.on('close', () => this.fail(new SmtpFailure('closed', 'connection closed by peer')));
  }

  static open(host: string, port: number, opts: ConnectionOptions): Promise<SmtpConnection> {
    return new Promise((resolve, reject) => {
      const socket = connect({ host, port });
      const timer = setTimeout(() => {
        socket.destroy();
        reject(new SmtpFailure('connect', `connect timeout after ${opts.connectTimeoutMs}ms`, 'ETIMEDOUT'));
      }, opts.connectTimeoutMs);
      const onError = (err: NodeJS.ErrnoException) => {
        clearTimeout(timer);
        socket.destroy();
        reject(new SmtpFailure('connect', err.message, err.code));
      };
      socket.once('error', onError);
      socket.once('connect', () => {
        clearTimeout(timer);
        socket.off('error', onError);
        resolve(new SmtpConnection(socket, opts));
      });
    });
  }

  /** Waits for the next complete reply (e.g. the 220 greeting). */
  read(): Promise<SmtpReply> {
    const queued = this.replies.shift();
    if (queued) return Promise.resolve(queued);
    if (this.failure) return Promise.reject(this.failure);
    if (this.waiter) return Promise.reject(new SmtpFailure('protocol', 'concurrent read'));

    return new Promise<SmtpReply>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiter = null;
        const err = new SmtpFailure('timeout', `no reply within ${this.opts.commandTimeoutMs}ms`);
        this.fail(err);
        reject(err);
      }, this.opts.commandTimeoutMs);
      this.waiter = {
        resolve: (r) => {
          clearTimeout(timer);
          resolve(r);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      };
    });
  }

  async command(line: string): Promise<SmtpReply> {
    if (this.failure) throw this.failure;
    if (/[\r\n]/.test(line)) throw new SmtpFailure('protocol', 'CR/LF in command'); // SMTP injection guard
    this.socket.write(`${line}\r\n`);
    return this.read();
  }

  /** Best-effort QUIT, then tear down. Never throws. */
  async close(): Promise<void> {
    if (!this.failure && !this.socket.destroyed) {
      try {
        this.socket.write('QUIT\r\n');
        await Promise.race([this.read(), new Promise((r) => setTimeout(r, 200))]);
      } catch {
        // ignore: we are leaving anyway
      }
    }
    this.failure ??= new SmtpFailure('closed', 'closed by client');
    this.socket.destroy();
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    if (this.buffer.length > MAX_BUFFER) {
      this.fail(new SmtpFailure('protocol', 'reply too large'));
      this.socket.destroy();
      return;
    }
    let nl: number;
    while ((nl = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, nl).replace(/\r$/, '');
      this.buffer = this.buffer.slice(nl + 1);
      this.onLine(line);
    }
  }

  private onLine(line: string): void {
    if (!/^\d{3}([ -]|$)/.test(line)) {
      this.fail(new SmtpFailure('protocol', `malformed reply line: ${line.slice(0, 80)}`));
      this.socket.destroy();
      return;
    }
    this.pendingLines.push(line);
    if (line[3] === '-') return; // continuation of a multi-line reply

    const lines = this.pendingLines;
    this.pendingLines = [];
    const code = Number(lines[0]!.slice(0, 3));
    const texts = lines.map((l) => l.slice(4));
    const enhanced = ENHANCED.exec(texts[0] ?? '')?.[1] ?? null;
    const reply: SmtpReply = { code, enhanced, message: texts.join('\n').trim() };

    if (this.waiter) {
      const w = this.waiter;
      this.waiter = null;
      w.resolve(reply);
    } else {
      this.replies.push(reply);
    }
  }

  private fail(err: SmtpFailure): void {
    if (this.failure) return;
    this.failure = err;
    if (this.waiter) {
      const w = this.waiter;
      this.waiter = null;
      w.reject(err);
    }
  }
}
