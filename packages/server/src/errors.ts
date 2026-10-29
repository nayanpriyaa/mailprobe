/** Errors that map to a specific HTTP status. Anything else is a 500. */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

export class ConflictError extends HttpError {
  constructor(message: string) {
    super(409, 'conflict', message);
  }
}

export class NotFoundError extends HttpError {
  constructor(what = 'resource') {
    super(404, 'not_found', `${what} not found`);
  }
}

export class PaymentRequiredError extends HttpError {
  constructor(needed: number, available: number) {
    super(402, 'insufficient_credits', `this request needs ${needed} credits; ${available} available`, {
      needed,
      available,
    });
  }
}
