// Provider error vocabulary — lets callers classify a failure (retryable vs not)
// WITHOUT importing a model SDK, so this stays dependency-free (the providers package
// must not leak SDK types upward). Both adapters throw ProviderError for the cases they
// detect (refusal / truncated / transient / permanent); isRetryableError additionally
// duck-types SDK/Node transient failures so one blip doesn't abort a whole task.

export type ProviderErrorKind = "refusal" | "truncated" | "transient" | "permanent";

export class ProviderError extends Error {
  readonly kind: ProviderErrorKind;
  readonly retryable: boolean;
  constructor(message: string, opts: { kind: ProviderErrorKind; retryable?: boolean }) {
    super(message);
    this.name = "ProviderError";
    this.kind = opts.kind;
    // transient ⇒ retryable by default; refusal/truncated/permanent ⇒ never.
    this.retryable = opts.retryable ?? opts.kind === "transient";
  }
}

const TRANSIENT_NODE_CODES = new Set(["ECONNRESET", "ETIMEDOUT", "ECONNREFUSED", "EPIPE", "ENOTFOUND", "EAI_AGAIN"]);

/**
 * True when an error is a transient failure worth retrying: a ProviderError flagged
 * retryable, an HTTP 408/429 or 5xx (duck-typed `status` — we never import the SDK), or
 * a known transient Node connection code. Everything else — a 4xx (incl. 409 Conflict,
 * which isn't generically safe to replay), a refusal, a real CLI error — is NOT retried.
 */
export function isRetryableError(err: unknown): boolean {
  if (err instanceof ProviderError) return err.retryable;
  if (typeof err !== "object" || err === null) return false;
  const e = err as { status?: unknown; code?: unknown };
  if (typeof e.status === "number" && (e.status === 408 || e.status === 429 || e.status >= 500)) return true;
  if (typeof e.code === "string" && TRANSIENT_NODE_CODES.has(e.code)) return true;
  return false;
}
