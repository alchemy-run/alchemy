import * as Effect from "effect/Effect";
import type * as Redacted from "effect/Redacted";
import type { Input } from "../Input.ts";
import { liftRedacted } from "../Util/redacted.ts";
import { Secret } from "./Secret.ts";

/** Properties for creating multiple Forgejo Actions secrets. */
export interface SecretsProps {
  /** Repository owner. */
  readonly owner: string;
  /** Repository name. */
  readonly repository: string;
  /** Secret values keyed by Actions secret name. */
  readonly secrets: Readonly<
    Record<string, Input<string | Redacted.Redacted<string>>>
  >;
}

/**
 * Create several Forgejo Actions secrets at once.
 *
 * Each entry becomes its own {@link Secret} resource, named after its key, so
 * adding or removing one key does not disturb the others.
 *
 * ### Creating Secrets in Bulk
 * **Example:** Repository Secrets from a Record
 * ```typescript
 * import * as Redacted from "effect/Redacted";
 *
 * yield* Forgejo.Secrets({
 *   owner: "acme",
 *   repository: "api",
 *   secrets: {
 *     DEPLOY_TOKEN: Redacted.make(process.env.DEPLOY_TOKEN!),
 *     NPM_TOKEN: Redacted.make(process.env.NPM_TOKEN!),
 *   },
 * });
 * ```
 *
 * @resource
 */
export const Secrets = Effect.fn(function* (props: SecretsProps) {
  return yield* Effect.forEach(
    Object.entries(props.secrets),
    ([name, value]) =>
      Secret(name, {
        owner: props.owner,
        repository: props.repository,
        name,
        // Lift through lazy inputs so the inner string is wrapped after the
        // engine resolves it — see `liftRedacted`.
        value: liftRedacted(value),
      }),
    { concurrency: "unbounded" },
  );
});
