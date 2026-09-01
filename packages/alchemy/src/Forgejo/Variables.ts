import * as Effect from "effect/Effect";
import type { Input } from "../Input.ts";
import { Variable } from "./Variable.ts";

/** Properties for creating multiple Forgejo Actions variables. */
export interface VariablesProps {
  /** Repository owner. */
  readonly owner: string;
  /** Repository name. */
  readonly repository: string;
  /** Values keyed by Actions variable name. */
  readonly variables: Readonly<Record<string, Input<string>>>;
}

/**
 * Create several Forgejo Actions variables at once.
 *
 * Each entry becomes its own {@link Variable} resource, named after its key,
 * so adding or removing one key does not disturb the others.
 *
 * ### Creating Variables in Bulk
 * **Example:** Repository Variables from a Record
 * ```typescript
 * yield* Forgejo.Variables({
 *   owner: "acme",
 *   repository: "api",
 *   variables: {
 *     DEPLOY_STAGE: "production",
 *     REGION: "us-east-1",
 *   },
 * });
 * ```
 *
 * @resource
 */
export const Variables = Effect.fn(function* (props: VariablesProps) {
  return yield* Effect.forEach(
    Object.entries(props.variables),
    ([name, value]) =>
      Variable(name, {
        owner: props.owner,
        repository: props.repository,
        name,
        value,
      }),
    { concurrency: "unbounded" },
  );
});
