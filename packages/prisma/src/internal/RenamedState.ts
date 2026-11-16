import type { Diff } from "alchemy/Diff";

/**
 * Plan an update for a state row saved under the attribute names a resource
 * had before it was renamed, so its next write stores the current names. The
 * plan exposes only `stables`, the stable attributes whose names did not
 * change; a renamed one exists in the row only under its old name, so
 * resources that read it wait for this resource's fresh output.
 */
export const updateRowSavedBeforeRename = <D extends Diff | undefined | void>(
  savedBeforeRename: boolean,
  diff: D,
  stables: string[] = [],
) =>
  savedBeforeRename && diff?.action !== "replace" ? { action: "update" as const, stables } : diff;
