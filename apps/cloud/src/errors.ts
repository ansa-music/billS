/** A business error that maps to an HTTP status. Messages are shown to people. */
export class CloudError extends Error {
  readonly status: number;
  readonly code: string;
  /** More fields of the answer's `error` object (e.g. `cloud` of a trial that moved to the cloud cash desk). */
  readonly extra: Readonly<Record<string, unknown>> | undefined;

  constructor(status: number, code: string, message: string, extra?: Record<string, unknown>) {
    super(message);
    this.name = 'CloudError';
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}
