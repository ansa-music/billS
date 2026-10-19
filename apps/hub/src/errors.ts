/** A business error that maps to an HTTP status. Messages are shown to staff. */
export class HubError extends Error {
  readonly status: number;
  readonly code: string;
  /** Extra fields sent inside `error` next to code and message (e.g. `retryAfterMs` of LOGIN_LOCKED). */
  readonly extra: Record<string, unknown> | undefined;

  constructor(status: number, code: string, message: string, extra?: Record<string, unknown>) {
    super(message);
    this.name = 'HubError';
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}
