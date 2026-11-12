import { createPhysicalName } from "alchemy/PhysicalName";
import { createInternalTags } from "alchemy/Tags";
import * as Effect from "effect/Effect";

/**
 * The name alchemy generates when the user gives none:
 * `<stack>-<id>-<stage>-<suffix>`, at most 50 characters.
 */
export const physicalName = (id: string) => createPhysicalName({ id, maxLength: 50 });

/**
 * A generated service name. ClickHouse documents service names as
 * "alphanumerical string with whitespaces up to 50 characters", so every
 * other character of the generated name becomes a space.
 */
export const serviceName = (id: string) =>
  Effect.map(physicalName(id), (name) =>
    name
      .replace(/[^A-Za-z0-9 ]+/g, " ")
      .replace(/ +/g, " ")
      .trim(),
  );

/** The user's name, the name already in state, or the generated name. */
export const resolveName = Effect.fn(function* (
  id: string,
  name: string | undefined,
  existing?: string,
) {
  return name ?? existing ?? (yield* physicalName(id));
});

/**
 * Whether an object found by `name` is ours: a name in state always is; a
 * user-chosen name with no state is not (adopting it needs `--adopt`); the
 * generated name is.
 */
export const isOwnedName = Effect.fn(function* (id: string, name: string, inState: boolean) {
  if (inState) return true;
  return name === (yield* physicalName(id));
});

/**
 * Whether a name has the shape alchemy generates: it ends in the base32
 * instance suffix. Objects with no tags (API keys, roles) are only listed
 * for `alchemy unsafe nuke` when their name has this shape, so keys and
 * roles people named by hand are never touched.
 */
export const isGeneratedName = (name: string) => /-[a-z2-7]{12,}$/i.test(name);

const tagValue = (value: string) => value.replace(/[^A-Za-z0-9._-]+/g, "_");

/**
 * Ownership tags for objects that carry ClickHouse tags. Tag keys and
 * values may only hold letters, digits, `-`, `_` and `.`, so alchemy's
 * `alchemy::stack` / `alchemy::stage` / `alchemy::id` become
 * `alchemy.stack` / `alchemy.stage` / `alchemy.id`, and other characters
 * in their values become `_`.
 */
export const ownerTags = Effect.fn(function* (id: string) {
  const internal = yield* createInternalTags(id);
  return {
    "alchemy.stack": tagValue(internal["alchemy::stack"]),
    "alchemy.stage": tagValue(internal["alchemy::stage"]),
    "alchemy.id": tagValue(internal["alchemy::id"]),
  } as Record<string, string>;
});

/** Whether `tags` carry this logical ID's ownership tags. */
export const hasOwnerTags = Effect.fn(function* (
  id: string,
  tags: ReadonlyArray<{ readonly key: string; readonly value?: string | undefined }> | undefined,
) {
  const owner = yield* ownerTags(id);
  return Object.entries(owner).every(([key, value]) =>
    (tags ?? []).some((tag) => tag.key === key && tag.value === value),
  );
});

/** Whether `tags` carry any alchemy ownership tag. */
export const isAlchemyTagged = (
  tags: ReadonlyArray<{ readonly key: string }> | undefined,
): boolean => (tags ?? []).some((tag) => tag.key === "alchemy.stack");
