/** An answer of the cloud HUB itself (not of the café's HUB): the same `{ error: { code, message } }` shape. */
export class CloudError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export function errorResponse(status: number, code: string, message: string, headers: HeadersInit = {}): Response {
  return Response.json({ error: { code, message } }, { status, headers });
}

export function toErrorResponse(err: unknown): Response {
  if (err instanceof CloudError) return errorResponse(err.status, err.code, err.message);
  console.error('[cloud hub]', err);
  return errorResponse(500, 'INTERNAL', 'Внутренняя ошибка облачной кассы');
}
