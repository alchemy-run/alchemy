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

/** A sanitized SDK failure; raw errors may contain secret values and are not retained. */
export class OnePasswordSecretsError extends Data.TaggedError("OnePasswordSecretsError")<{
  readonly environmentId?: string;
  readonly operation: OnePasswordOperation;
  readonly reason:
    | "SdkError"
    | "AuthExpired"
    | "DesktopSessionExpired"
    | "Timeout"
    | "InvalidEnvironment"
    | "InvalidOptions";
}> {
  readonly [UserFacingError] = true;
  override get message() {
    const prefix = `1Password could not ${this.operation} ${this.environmentId === undefined ? "secret references" : `Environment '${this.environmentId}'`}.`;
    switch (this.reason) {
      case "AuthExpired":
        return `${prefix} Service-account authentication expired. Check or replace OP_SERVICE_ACCOUNT_TOKEN and verify Environment or vault access.`;
      case "DesktopSessionExpired":
        return `${prefix} Unlock the 1Password desktop app and authorize Alchemy again. Enable Settings > Developer > Integrate with other apps.`;
      case "Timeout":
        return `${prefix} The operation timed out. Check network access and, for desktop authentication, unlock 1Password and approve the authorization prompt.`;
      case "InvalidEnvironment":
        return "1Password: environmentId must be non-empty and the Environment must contain unique, non-empty variable names with string values.";
      case "InvalidOptions":
        return "1Password: specify exactly one of a non-empty environmentId or a non-empty references map. References must be op://vault/item/[section/]field strings with supported SDK syntax and non-empty config keys. Optional queries are ?attribute=otp or ?ssh-format=openssh. Use IDs for names with unsupported characters, not URL encoding.";
      default:
        return `${prefix} Check the Environment ID or secret references and read permissions, OP_SERVICE_ACCOUNT_TOKEN or desktop account selection, and the 1Password SDK installation. For desktop access, unlock the app and enable Settings > Developer > Integrate with other apps.`;
    }
  }
}

/** A reference could not be resolved. Neither its URI nor the SDK error is retained. */
export class OnePasswordReferenceError extends Data.TaggedError("OnePasswordReferenceError")<{
  readonly configKey: string;
  readonly reason: "InvalidReference" | "ResolutionFailed" | "MissingResponse";
}> {
  readonly [UserFacingError] = true;
  override get message() {
    return `1Password could not resolve the reference for config key '${this.configKey}'. Check the op://vault/item/[section/]field syntax, that the vault, item and field exist, and read permissions. No partial config was loaded.`;
  }
}
