import { isResolved } from "alchemy/Diff";

/**
 * Read one prop of a `diff` input that may not be resolved as a whole.
 * `diff` receives `Input<Props>`, whose union members don't share the prop.
 */
export const rawProp = <Props>(news: unknown, key: keyof Props & string): unknown =>
  (news as Readonly<Record<string, unknown>> | undefined)?.[key];

/**
 * Whether a replace-trigger prop of a `diff` input is still an unresolved
 * plan-time expression.
 *
 * `diff` runs before upstream resources are applied. An id taken from an
 * upstream being replaced or created is unresolved, and its new value is
 * unknown, so the prop can't be proven unchanged. Bailing out of `diff` on
 * `!isResolved(news)` hands that case to the engine's default, an in-place
 * update, which keeps the old physical resource bound to the old upstream.
 * Check the triggers first and replace, then compare them through
 * {@link triggerProps}:
 *
 * ```ts
 * if (output === undefined) return undefined;
 * if (hasUnresolvedTrigger<SnapshotProps>(news, ["projectId", "region", "volumeId"])) {
 *   return { action: "replace" } as const;
 * }
 * const resolved = triggerProps<SnapshotProps>(news);
 * if (resolved.volumeId !== output.volumeId) return { action: "replace" } as const;
 * ```
 *
 * An unresolved prop can still resolve to the value it already has (an
 * upstream recovering from an interrupted update). A resource whose identity
 * holds no generation marker (a pair of ids, or a unique name) would then see
 * its replacement claim the very object garbage collection is about to
 * delete, so such a resource returns `deleteFirst: true` here.
 */
export const hasUnresolvedTrigger = <Props>(
  news: unknown,
  keys: ReadonlyArray<keyof Props & string>,
): boolean => keys.some((key) => !isResolved(rawProp<Props>(news, key)));

/**
 * A `diff` input typed as resolved, for comparing the props `hasUnresolvedTrigger`
 * just cleared. Read nothing else through it: any other prop can still be unresolved.
 *
 * Compare before any `!isResolved(news)` bail. Otherwise an unrelated unresolved prop
 * hides a resolved identity change, the engine runs an in-place update, reconcile
 * creates a second resource at the new identity, and the old one keeps running with
 * no state row to delete it.
 */
export const triggerProps = <Props>(news: unknown): Props => news as Props;
