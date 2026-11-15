import type { Diff } from "alchemy/Diff";

/**
 * Plan an update for a state row saved under the attribute names a resource
 * had before it was renamed, so its next write stores the current names. The
 * plan exposes no stable attribute: the row holds them only under the old
 * names, so resources that read them wait for this resource's fresh output.
 */
export const updateRowSavedBeforeRename = <D extends Diff | undefined | void>(
  savedBeforeRename: boolean,
  diff: D,
) =>
  savedBeforeRename && diff?.action !== "replace"
    ? { action: "update" as const, stables: [] as string[] }
    : diff;
