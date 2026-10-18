/** A business error that maps to an HTTP status. Messages are shown to staff. */
export class HubError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'HubError';
    this.status = status;
    this.code = code;
  }
}
