/** A business error that maps to an HTTP status. Messages are shown to people. */
export class CloudError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'CloudError';
    this.status = status;
    this.code = code;
  }
}
