export class CleanerError extends Error {
  readonly code: string;
  readonly status?: number;
  readonly retryAfterMs?: number;

  constructor(
    message: string,
    options: { code?: string; status?: number; retryAfterMs?: number } = {},
  ) {
    super(message);
    this.name = 'CleanerError';
    this.code = options.code ?? 'UNKNOWN';
    if (options.status !== undefined) this.status = options.status;
    if (options.retryAfterMs !== undefined) this.retryAfterMs = options.retryAfterMs;
  }
}

export const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);
