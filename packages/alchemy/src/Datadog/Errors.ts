import * as Data from "effect/Data";

/**
 * The requested resource does not exist (HTTP 404). Lifecycle operations
 * catch this tag to treat out-of-band deletions as "no observed state".
 */
export class DatadogNotFound extends Data.TaggedError("Datadog.NotFound")<{
  /** Human-readable description of what was being fetched, e.g. `monitor 123`. */
  readonly resource: string;
  readonly errors: ReadonlyArray<string>;
}> {}

/**
 * The API rejected the credentials (HTTP 401/403). Check `DD_API_KEY` /
 * `DD_APP_KEY` and that the application key has the required scopes
 * (`monitors_write`, `slos_write`).
 */
export class DatadogAuthError extends Data.TaggedError("Datadog.AuthError")<{
  readonly status: number;
  readonly errors: ReadonlyArray<string>;
}> {}

/**
 * The request body failed Datadog-side validation (HTTP 400/422) — e.g. a
 * malformed monitor query or an SLO threshold outside (0, 100).
 */
export class DatadogValidationError extends Data.TaggedError(
  "Datadog.ValidationError",
)<{
  readonly status: number;
  readonly errors: ReadonlyArray<string>;
}> {}

/**
 * Rate limited (HTTP 429). The API client retries these internally with
 * bounded backoff; this surfaces only after retries are exhausted.
 */
export class DatadogRateLimited extends Data.TaggedError(
  "Datadog.RateLimited",
)<{
  /** Seconds until the limit resets, from the `x-ratelimit-reset` header. */
  readonly retryAfterSeconds: number | undefined;
}> {}

/**
 * Any other non-2xx response (5xx, unexpected 4xx) or a transport failure
 * (`status: 0`).
 */
export class DatadogApiError extends Data.TaggedError("Datadog.ApiError")<{
  readonly status: number;
  readonly errors: ReadonlyArray<string>;
}> {}

/** Union of every error a Datadog API request can fail with. */
export type DatadogRequestError =
  | DatadogNotFound
  | DatadogAuthError
  | DatadogValidationError
  | DatadogRateLimited
  | DatadogApiError;
