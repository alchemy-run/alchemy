import { UserFacingError } from "alchemy/UserFacingError";
import * as Data from "effect/Data";

/** The CLI step that failed. Its output may echo values, so it is never retained. */
export type ProtonPassOperation = "login" | "read" | "logout";

/**
 * Why Proton Pass could not resolve a reference or item: the reference is
 * malformed (`parsing`), or the vault, item or field it names doesn't exist or
 * isn't readable with the current session.
 */
export type ProtonPassReferenceErrorType =
  | "parsing"
  | "vaultNotFound"
  | "itemNotFound"
  | "fieldNotFound";

/** `pass-cli` is not installed or not on PATH. */
export class ProtonPassCliNotFoundError extends Data.TaggedError("ProtonPassCliNotFoundError")<{
  readonly command: string;
}> {
  readonly [UserFacingError] = true;
  override get message() {
    return `The Proton Pass CLI ('${this.command}') was not found. Install it from https://protonpass.github.io/pass-cli/ and make sure it is on PATH.`;
  }
}

/** The Proton Pass CLI has no session to read with. */
export class ProtonPassNotLoggedInError extends Data.TaggedError("ProtonPassNotLoggedInError")<{}> {
  readonly [UserFacingError] = true;
  override get message() {
    return "The Proton Pass CLI is not logged in. Run `pass-cli login` locally, or set PROTON_PASS_PERSONAL_ACCESS_TOKEN in CI.";
  }
}

/** Proton Pass rejected the personal access token. */
export class ProtonPassAuthError extends Data.TaggedError("ProtonPassAuthError")<{}> {
  readonly [UserFacingError] = true;
  override get message() {
    return "Proton Pass rejected the personal access token. Check its pst_<token>::<key> format and expiry, or create a new one with `pass-cli personal-access-token create`.";
  }
}

/**
 * A reference could not be resolved, so nothing was loaded. The reference and
 * the CLI's message are not retained.
 */
export class ProtonPassReferenceError extends Data.TaggedError("ProtonPassReferenceError")<{
  readonly configKey: string;
  readonly errorType?: ProtonPassReferenceErrorType;
}> {
  readonly [UserFacingError] = true;
  override get message() {
    return `Proton Pass could not resolve the reference for config key '${this.configKey}'${this.errorType ? ` (${this.errorType})` : ""}. Check its pass://vault/item/field syntax and that the token or session can read the vault. No partial config was loaded.`;
  }
}

/** An item could not be read, so nothing was loaded. */
export class ProtonPassItemError extends Data.TaggedError("ProtonPassItemError")<{
  readonly vault: string;
  readonly item: string;
  readonly errorType?: ProtonPassReferenceErrorType;
}> {
  readonly [UserFacingError] = true;
  override get message() {
    return `Proton Pass could not read item '${this.item}' in vault '${this.vault}'${this.errorType ? ` (${this.errorType})` : ""}. Check the names or IDs and that the token or session can read the vault.`;
  }
}

/** Two fields of one item share a name, so the config key would be ambiguous. */
export class ProtonPassDuplicateFieldError extends Data.TaggedError(
  "ProtonPassDuplicateFieldError",
)<{
  readonly item: string;
  readonly field: string;
}> {
  readonly [UserFacingError] = true;
  override get message() {
    return `Proton Pass item '${this.item}' has more than one field named '${this.field}'. Rename one, or load it with SecretReferences using a Section.field reference.`;
  }
}

/** The CLI failed for a reason Alchemy doesn't classify. */
export class ProtonPassCliError extends Data.TaggedError("ProtonPassCliError")<{
  readonly operation: ProtonPassOperation;
  readonly exitCode?: number;
}> {
  readonly [UserFacingError] = true;
  override get message() {
    return `The Proton Pass CLI failed during ${this.operation}${this.exitCode === undefined ? "" : ` (exit code ${this.exitCode})`}. Run \`pass-cli info\` to check the session.`;
  }
}

/** A CLI call didn't finish in time. */
export class ProtonPassTimeoutError extends Data.TaggedError("ProtonPassTimeoutError")<{
  readonly operation: ProtonPassOperation;
}> {
  readonly [UserFacingError] = true;
  override get message() {
    return `The Proton Pass CLI timed out during ${this.operation}. Check network access and run \`pass-cli info\`.`;
  }
}
