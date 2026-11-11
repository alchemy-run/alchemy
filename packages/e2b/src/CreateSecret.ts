import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type * as Redacted from "effect/Redacted";
import type { E2BError } from "./SandboxClient.ts";
import type { SecretAttributes } from "./Secret.ts";

/** A secret as E2B reports it: never its value. `ref` is the egress placeholder. */
export type SecretInfo = SecretAttributes;

/** E2B secrets by name: store, look up, list and delete them. */
export interface SecretsClient {
  /**
   * Stores a value under a name: creates the secret, or adds a new version
   * of an existing one. Returns its `ref` to use in sandbox network rules.
   */
  put(
    name: string,
    value: Redacted.Redacted<string>,
    options?: { readonly metadata?: Readonly<Record<string, string>> },
  ): Effect.Effect<SecretInfo, E2BError, RuntimeContext>;
  /** The secret with this name or id, or `undefined`. */
  get(nameOrId: string): Effect.Effect<SecretInfo | undefined, E2BError, RuntimeContext>;
  /** The secrets this host created. */
  list(): Effect.Effect<ReadonlyArray<SecretInfo>, E2BError, RuntimeContext>;
  /** Deletes a secret. Deleting one that is gone succeeds. */
  delete(nameOrId: string): Effect.Effect<void, E2BError, RuntimeContext>;
}

/**
 * Store per-user credentials as E2B secrets at runtime, and reference them
 * from a sandbox's network rules so the sandbox never sees the value.
 *
 * Secrets created at run time are tagged with the stack, stage and binding
 * (`alchemy::stack`, `alchemy::stage`, `alchemy::id` in their E2B metadata)
 * and are not deleted when the stack is destroyed. List them by those tags
 * to clean them up: `secrets.list()` returns the ones this binding stored.
 * Metadata you pass to `put` merges underneath; it never replaces the
 * `alchemy::*` keys.
 *
 * ### Per-user credentials at egress
 * **Example:** A user's GitHub token, injected into their sandbox's GitHub calls
 * ```typescript
 * const secrets = yield* E2B.CreateSecret();
 * const sandboxes = yield* E2B.CreateSandbox(Agent);
 * // in fetch:
 * const github = yield* secrets.put(`github-${user}`, Redacted.make(token));
 * const sandbox = yield* sandboxes.create({
 *   network: {
 *     allowOut: ["api.github.com"],
 *     rules: { "api.github.com": [{ transform: { headers: { Authorization: `Bearer ${github.ref}` } } }] },
 *   },
 * });
 * ```
 *
 * @binding
 * @product Secret
 */
export interface CreateSecret extends Binding.Service<
  CreateSecret,
  "E2B.CreateSecret",
  () => Effect.Effect<SecretsClient>
> {}

export const CreateSecret = Binding.Service<CreateSecret>("E2B.CreateSecret");
