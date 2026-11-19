import type * as secrets from "@distilled.cloud/daytona/secret";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type * as Redacted from "effect/Redacted";
import type { SecretAttributes } from "./Secret.ts";

export interface CreateSecretClient {
  /**
   * Create the secret, or write a new value (and description and hosts)
   * to the one with this name. Returns the same attributes as
   * `Daytona.Secret`; pass `placeholder` into a sandbox's env or the
   * secret's `name` in `secrets`.
   */
  put(input: {
    readonly name: string;
    readonly value: string | Redacted.Redacted<string>;
    readonly description?: string;
    readonly hosts?: string[];
  }): Effect.Effect<
    SecretAttributes,
    secrets.CreateSecretError | secrets.UpdateSecretError | secrets.ListSecretsPaginatedError,
    RuntimeContext
  >;
  /** The secret with this name, or `undefined`. Values are never returned. */
  get(
    name: string,
  ): Effect.Effect<SecretAttributes | undefined, secrets.ListSecretsPaginatedError, RuntimeContext>;
  /** Every secret in the organization. */
  list(): Effect.Effect<SecretAttributes[], secrets.ListSecretsPaginatedError, RuntimeContext>;
  /** Delete the secret with this name. Deleting a missing one succeeds. */
  delete(
    name: string,
  ): Effect.Effect<
    void,
    secrets.DeleteSecretError | secrets.ListSecretsPaginatedError,
    RuntimeContext
  >;
}

/**
 * Store secrets in Daytona at runtime: a credential per user, injected
 * into that user's sandboxes without the sandbox (or an agent in it)
 * ever seeing the value. Daytona swaps the placeholder for the value only
 * on requests to the secret's `hosts`.
 *
 * The host gets its own Daytona API key with `manage:secrets`. Secrets
 * have no labels, so each one it creates carries `stack/stage/id` in its
 * description. They are not deleted when the stack is destroyed: list them
 * (`list()`) and match the description to clean them up.
 *
 * ### A Credential per User
 * **Example:** The user's GitHub token, only sent to GitHub's API
 * ```typescript
 * const secrets = yield* Daytona.CreateSecret();
 * const github = yield* secrets.put({
 *   name: `github-${user}`,
 *   value: token,
 *   hosts: ["api.github.com"],
 * });
 * const sandbox = yield* sandboxes.create({ secrets: [{ GITHUB_TOKEN: github.name }] });
 * ```
 *
 * @binding
 * @product Secret
 */
export interface CreateSecret extends Binding.Service<
  CreateSecret,
  "Daytona.CreateSecret",
  () => Effect.Effect<CreateSecretClient>
> {}

export const CreateSecret = Binding.Service<CreateSecret>("Daytona.CreateSecret");
