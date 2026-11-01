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
 * Check the triggers first and replace:
 *
 * ```ts
 * if (output === undefined) return undefined;
 * if (hasUnresolvedTrigger<SnapshotProps>(news, ["projectId", "region", "volumeId"])) {
 *   return { action: "replace" } as const;
 * }
 * if (!isResolved(news)) return undefined;
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
