/**
 * The retry policy alchemy installs on every distilled SDK it deploys with.
 *
 * Distilled's own default is tuned for calls at runtime (a Worker, a Lambda):
 * 3 attempts, a retry budget, and only errors marked retryable. A deploy
 * wants more patience, so this keeps distilled's earlier default:
 *
 * - retries errors marked retryable, throttling, server (5xx), network,
 *   timeout and locked errors, and transport failures;
 * - backs off `250ms × 2^n`, capped at 5s, at least 500ms for throttling;
 * - a server `Retry-After` / `RateLimit` hint replaces the backoff, capped
 *   at 60s (`DISTILLED_SERVER_RETRY_HINT_CAP_MS` changes the cap);
 *
 * It reads distilled's error marks by their keys, so `alchemy` keeps no
 * dependency on distilled.
 * - adds up to 50ms of jitter;
 * - gives up after 8 retries (9 attempts), about 20s of backoff.
 *
 * @example
 * ```ts
 * Layer.provideMerge(Layer.succeed(Cloudflare.Retry, DeployRetry.policy))
 * ```
 */
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as HttpClientError from "effect/http/HttpClientError";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";

/**
 * A distilled retry factory (`@distilled.cloud/core/retry` `Factory`). Typed
 * here so this module does not depend on distilled.
 */
export type Factory = (lastError: Ref.Ref<unknown>) => {
  readonly while?: (error: unknown) => boolean;
  readonly schedule?: Schedule.Schedule<unknown>;
};

// distilled's error marks (`@distilled.cloud/core/category`).
const CATEGORIES_KEY = "@distilled.cloud/error/categories";
const RETRYABLE_KEY = "@distilled.cloud/error/retryable";
const TRANSIENT_CATEGORIES = [
  "RetryableError",
  "ThrottlingError",
  "ServerError",
  "NetworkError",
  "TimeoutError",
  "LockedError",
];

const categories = (error: unknown): object | undefined => {
  const value = (error as Record<string, unknown> | null | undefined)?.[CATEGORIES_KEY];
  return typeof value === "object" && value !== null ? value : undefined;
};
const retryableMark = (error: unknown): { throttling?: boolean } | undefined =>
  typeof error === "object" && error !== null && RETRYABLE_KEY in error
    ? ((error as Record<string, { throttling?: boolean }>)[RETRYABLE_KEY] ?? {})
    : undefined;

const isThrottling = (error: unknown): boolean => {
  const mark = retryableMark(error);
  if (mark !== undefined) return mark.throttling === true;
  return "ThrottlingError" in (categories(error) ?? {});
};

/** Most retries after the first attempt. */
export const MAX_RETRIES = 8;
const BASE_MS = 250;
const CAP_MS = 5_000;
const MIN_THROTTLE_MS = 500;
const JITTER_MS = 50;

/**
 * Whether a deploy should retry `error`: anything marked retryable, plus the
 * categories that describe a transient failure, plus transport failures.
 */
export const isTransient = (error: unknown): boolean => {
  if (retryableMark(error) !== undefined) return true;
  const marks = categories(error);
  if (marks !== undefined && TRANSIENT_CATEGORIES.some((c) => c in marks)) return true;
  return HttpClientError.isHttpClientError(error) && error.reason._tag === "TransportError";
};

/**
 * The longest server hint honored, in milliseconds: 60s, or
 * `DISTILLED_SERVER_RETRY_HINT_CAP_MS` (as distilled reads it).
 */
const hintCapMs = (): number => {
  const raw = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process
    ?.env?.DISTILLED_SERVER_RETRY_HINT_CAP_MS;
  const n = raw === undefined || raw === "" ? Number.NaN : Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.trunc(n) : 60_000;
};

/** The delay before the next retry, in milliseconds, after `error`. */
const delayAfter = (error: unknown, backoffMs: number): number => {
  const hint = (error as { retryAfter?: unknown } | null | undefined)?.retryAfter;
  const jitter = Math.random() * JITTER_MS;
  if (Duration.isDuration(hint)) return Math.min(Duration.toMillis(hint), hintCapMs()) + jitter;
  const capped = Math.min(backoffMs, CAP_MS);
  const floored = capped < MIN_THROTTLE_MS && isThrottling(error) ? MIN_THROTTLE_MS : capped;
  return floored + jitter;
};

/** The deploy policy, for `Layer.succeed(<SDK>.Retry, policy)`. */
export const policy: Factory = (lastError) => ({
  while: isTransient,
  // Both must continue; the delay is the larger, the backoff's.
  schedule: Schedule.max([
    Schedule.exponential(Duration.millis(BASE_MS), 2).pipe(
      Schedule.modifyDelay(({ duration }) =>
        Effect.map(Ref.get(lastError), (error) => delayAfter(error, Duration.toMillis(duration))),
      ),
    ),
    Schedule.recurs(MAX_RETRIES),
  ]),
});
