import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type * as Redacted from "effect/Redacted";
import type { E2BError } from "./SandboxClient.ts";
import type { Secret, SecretAttributes } from "./Secret.ts";

/** Rotate one declared secret. */
export interface WriteSecretClient {
  /** Stores a new version of the secret. Sandboxes resolve it on their next request. */
  put(value: Redacted.Redacted<string>): Effect.Effect<SecretAttributes, E2BError, RuntimeContext>;
}

/**
 * Rotate a declared {@link Secret} at runtime: a scheduled job refreshing a
 * short-lived token, or a webhook storing a reissued credential. Sandboxes
 * resolve the new version on their next request.
 *
 * A later deploy stores the declared `value` again only when that value
 * changes.
 *
 * ### Rotating a secret
 * **Example:** Store a refreshed token
 * ```typescript
 * const token = yield* E2B.WriteSecret(GitHubToken);
 * // in a scheduled handler:
 * yield* token.put(Redacted.make(fresh));
 * ```
 *
 * @binding
 * @product Secret
 */
export interface WriteSecret extends Binding.Service<
  WriteSecret,
  "E2B.WriteSecret",
  (secret: Secret) => Effect.Effect<WriteSecretClient>
> {}

export const WriteSecret = Binding.Service<WriteSecret>("E2B.WriteSecret");
