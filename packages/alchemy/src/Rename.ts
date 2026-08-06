import * as Context from "effect/Context";
import * as Effect from "effect/Effect";

/**
 * A former id a resource was previously declared under:
 *
 * - a bare `string` resolves against the ambient namespace, exactly like
 *   the resource's own `id` argument does
 * - `{ fqn: "..." }` is absolute — the full FQN as persisted in state,
 *   ignoring any surrounding namespace. Needed when a resource moved
 *   BETWEEN namespaces (a relative id can only address the current
 *   namespace's subtree).
 */
export type FormerId = string | { fqn: string };

/**
 * RenamePolicy carries the former ids a resource was previously declared
 * under. It is captured from the ambient context at registration time (like
 * `AdoptPolicy` / `RemovalPolicy`) and resolved against the same namespace
 * as the resource's own id — see `ResourceLike.FormerFqns`.
 */
export class RenamePolicy extends Context.Service<
  RenamePolicy,
  readonly FormerId[]
>()("RenamePolicy") {}

/**
 * Declare the logical id(s) this resource was previously registered under,
 * so the engine migrates its persisted state row instead of planning a
 * create+delete replacement when the id changes.
 *
 * ```ts
 * // was: Bucket("Bucket") — the row migrates and the deploy plans a noop
 * const bucket = yield* Bucket("Assets").pipe(renamedFrom("Bucket"));
 * ```
 *
 * A bare string resolves against the ambient namespace, exactly like the
 * resource's own `id`:
 *
 * ```ts
 * // FQN `Site/Assets`, former FQN `Site/Bucket`
 * yield* Bucket("Assets").pipe(
 *   renamedFrom("Bucket"),
 *   Namespace.push("Site"),
 * );
 * ```
 *
 * Moved between namespaces? Pass `{ fqn }` — the absolute FQN exactly as
 * persisted in state, ignoring the ambient namespace:
 *
 * ```ts
 * // former FQN `LegacySite/Assets` (NOT `NewSite/LegacySite/Assets`)
 * yield* Bucket("Assets").pipe(
 *   renamedFrom({ fqn: "LegacySite/Assets" }),
 *   Namespace.push("NewSite"),
 * );
 * ```
 *
 * Renamed more than once? List every former id, most recent first — the
 * planner checks them in order and migrates from the first matching row:
 *
 * ```ts
 * // rename history: Bucket → StaticAssets → Assets
 * yield* Bucket("Assets").pipe(renamedFrom("StaticAssets", "Bucket"));
 * ```
 *
 * Migration semantics, by state-row shape (see Plan's `getPersistedRow`;
 * `new` = the row at the resource's FQN, `old` = a row at a former FQN):
 *
 * ```text
 * new                     old                     → outcome
 * ──────────────────────────────────────────────────────────────────────
 * —                       row                     → migrate: the old row
 *                                                   IS the resource's
 *                                                   state (noop/update,
 *                                                   never a create);
 *                                                   apply moves it before
 *                                                   any lifecycle op
 * row, same instanceId    row                     → interrupted
 *                                                   migration: leftovers
 *                                                   dropped state-only —
 *                                                   ALL of them in one
 *                                                   apply — the physical
 *                                                   resource is never
 *                                                   touched
 * row, diff instanceId    row                     → someone else's row (a
 *                                                   new resource reusing
 *                                                   the old name):
 *                                                   ignored, normal
 *                                                   orphan handling
 * row, diff resourceType  row                     → the new-FQN row is
 *                                                   not a claim (it
 *                                                   cannot be this
 *                                                   resource's row); the
 *                                                   type-matching old row
 *                                                   migrates over it
 * any                     row, diff resourceType  → never migrated —
 *                                                   cannot be this
 *                                                   resource's row,
 *                                                   whatever its FQN says
 * ```
 *
 * A former FQN that is still actively declared is not a rename and is
 * ignored; two resources claiming the same former FQN fail the plan
 * loudly.
 */
export const renamedFrom =
  (...formerIds: [FormerId, ...FormerId[]]) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
    Effect.provideService(effect, RenamePolicy, formerIds);
