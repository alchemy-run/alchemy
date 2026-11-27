import { createPhysicalName } from "alchemy/PhysicalName";
import * as Effect from "effect/Effect";

/**
 * Coolify has no labels on projects and environments, and its tags are
 * team-wide names that `POST /deploy?tag=` deploys as a group, so a
 * per-resource ownership tag would both flood the tag list and widen every
 * tag deploy. Ownership is stamped into the physical name instead:
 * `createPhysicalName` encodes stack, logical id, stage and the instance
 * suffix, so a resource whose name equals the name this logical id would
 * generate was created by this stack. Anything else found under the same
 * name is reported `Unowned` and needs `--adopt`.
 */
export const COOLIFY_NAME_MAX_LENGTH = 63;

/** The name Alchemy generates for a resource when the user sets none. */
export const physicalName = (id: string) =>
  createPhysicalName({ id, lowercase: true, maxLength: COOLIFY_NAME_MAX_LENGTH });

/**
 * Resolve the name a resource should have: the user's name, else the name
 * already in state, else a generated one.
 */
export const resolveName = (id: string, name: string | undefined, existing?: string) =>
  Effect.gen(function* () {
    if (name !== undefined) return name;
    if (existing !== undefined) return existing;
    return yield* physicalName(id);
  });

/**
 * True when `name` is the one this logical id generates, which only this
 * stack, stage and resource instance produce.
 */
export const isGeneratedName = (id: string, name: string | undefined) =>
  Effect.gen(function* () {
    if (name === undefined) return false;
    return name === (yield* physicalName(id));
  });

/**
 * True when `name` has the shape of a generated physical name (a trailing
 * base32 instance suffix). Used by `list` so `alchemy unsafe nuke` only
 * enumerates resources Alchemy named.
 */
export const looksGenerated = (name: string | undefined): boolean => {
  if (name === undefined || name.length === 0 || name.length > COOLIFY_NAME_MAX_LENGTH) {
    return false;
  }
  if (!/^[a-z0-9-]+$/.test(name)) return false;
  const last = name.split("-").at(-1) ?? "";
  return last.length >= 8 && last.length <= 24 && /^[a-z2-7]+$/.test(last);
};
