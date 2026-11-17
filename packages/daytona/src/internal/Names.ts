import { createPhysicalName } from "alchemy/PhysicalName";
import * as Effect from "effect/Effect";

/**
 * The name alchemy generates for a Daytona object when the user gives none:
 * `<stack>-<id>-<stage>-<suffix>`, lowercase. Daytona volumes, secrets,
 * snapshots and registries have no labels, so this name is also their
 * ownership marker: only alchemy produces the random suffix, so an object
 * with exactly this name was created by this logical id.
 */
export const physicalName = (id: string, maxLength = 63) =>
  createPhysicalName({ id, maxLength, delimiter: "-", lowercase: true });

/** The user's name, the name already in state, or the generated name. */
export const resolveName = Effect.fn(function* (
  id: string,
  name: string | undefined,
  existing?: string,
  maxLength?: number,
) {
  return name ?? existing ?? (yield* physicalName(id, maxLength));
});

/**
 * Whether an object found by `name` is ours: a name in state always is; a
 * user-chosen name with no state is not (adopting it needs `--adopt`); a
 * generated name is.
 */
export const isOwnedName = Effect.fn(function* (
  id: string,
  name: string,
  inState: boolean,
  maxLength?: number,
) {
  if (inState) return true;
  return name === (yield* physicalName(id, maxLength));
});
