import { UserFacingError } from "alchemy/UserFacingError";
import * as Data from "effect/Data";

/** The SDK operation that failed, without retaining credentials or returned values. */
export type OnePasswordOperation = "initialize" | "authenticate" | "read" | "resolve";

/**
 * 1Password rejected a request because a rate limit was exceeded.
 * Alchemy does not automatically retry: service-account quotas can take hours
 * to reset, and the SDK does not expose a structured retry-after duration.
 */
export class OnePasswordRateLimitError extends Data.TaggedError("OnePasswordRateLimitError")<{
  readonly environmentId?: string;
  readonly operation: OnePasswordOperation;
}> {
  readonly [UserFacingError] = true;
  override get message() {
    return `1Password rate limit exceeded while attempting to ${this.operation} ${this.environmentId === undefined ? "secret references" : `Environment '${this.environmentId}'`}. No automatic retry was made. Service accounts have hourly limits and account-wide daily limits. Check usage with \`op service-account ratelimit\`, wait for the quota to reset, and reduce concurrent CI jobs. See https://www.1password.dev/service-accounts/rate-limits.`;
  }
}

/**
 * The SDK failed for a reason it doesn't classify, or couldn't be loaded.
 * The raw error may contain secret values and is not retained.
 */
export class OnePasswordSdkError extends Data.TaggedError("OnePasswordSdkError")<{
  readonly environmentId?: string;
  readonly operation: OnePasswordOperation;
}> {
  readonly [UserFacingError] = true;
  override get message() {
    return `1Password could not ${this.operation} ${this.environmentId === undefined ? "secret references" : `Environment '${this.environmentId}'`}. Check the Environment ID and read access, and that @1password/sdk is installed.`;
  }
}

/** The service account token was rejected or has expired. */
export class OnePasswordAuthExpiredError extends Data.TaggedError(
  "OnePasswordAuthExpiredError",
)<{}> {
  readonly [UserFacingError] = true;
  override get message() {
    return "1Password rejected the service account token. Check or replace OP_SERVICE_ACCOUNT_TOKEN.";
  }
}

/** The desktop app's authorization ended, e.g. because 1Password locked. */
export class OnePasswordDesktopSessionExpiredError extends Data.TaggedError(
  "OnePasswordDesktopSessionExpiredError",
)<{}> {
  readonly [UserFacingError] = true;
  override get message() {
    return "1Password desktop authorization expired. Unlock the app and authorize Alchemy again.";
  }
}

/** The desktop app has no account matching the `account` selector. */
export class OnePasswordAccountNotFoundError extends Data.TaggedError(
  "OnePasswordAccountNotFoundError",
)<{
  readonly account: string;
}> {
  readonly [UserFacingError] = true;
  override get message() {
    return `The 1Password desktop app has no account '${this.account}'. Use the name in the app's account switcher (e.g. Family, case-sensitive), the sign-in address (my.1password.com), or the account UUID.`;
  }
}

/** A 1Password call didn't finish in time. */
export class OnePasswordTimeoutError extends Data.TaggedError("OnePasswordTimeoutError")<{
  readonly operation: OnePasswordOperation;
}> {
  readonly [UserFacingError] = true;
  override get message() {
    return `1Password timed out during ${this.operation}. Check network access; for the desktop app, unlock 1Password and approve the authorization prompt.`;
  }
}

/**
 * A reference could not be resolved, so nothing was loaded. Neither its URI nor
 * the SDK's free-text message is retained; `errorType` is the SDK's fixed error
 * kind (e.g. `parsing`, `fieldNotFound`, `itemNotFound`, `vaultNotFound`).
 */
export class OnePasswordReferenceError extends Data.TaggedError("OnePasswordReferenceError")<{
  readonly configKey: string;
  readonly errorType?: string;
}> {
  readonly [UserFacingError] = true;
  override get message() {
    return `1Password could not resolve the reference for config key '${this.configKey}'${this.errorType ? ` (${this.errorType})` : ""}. Check its op://vault/item/[section/]field syntax and that the field exists and is readable. No partial config was loaded.`;
  }
}
