import * as Context from "effect/Context";
import * as Effect from "effect/Effect";

/**
 * RenamePolicy carries the logical ids a resource was previously declared
 * under. It is captured from the ambient context at registration time (like
 * `AdoptPolicy` / `RemovalPolicy`) and resolved against the same namespace
 * as the resource's own id — see `ResourceLike.FormerFqns`.
 */
export class RenamePolicy extends Context.Service<
  RenamePolicy,
  readonly string[]
>()("RenamePolicy") {}

/**
 * Declare the logical id(s) this resource was previously registered under,
 * so the engine migrates its persisted state row instead of planning a
 * create+delete replacement when the id changes.
 *
 * ```ts
 * // was `Worker("Website/Worker", ...)` in a previous release:
 * const worker = yield* Worker("Website", props).pipe(
 *   renamedFrom("Website/Worker"),
 * );
 * ```
 *
 * Former ids are namespace-relative: they resolve against the same ambient
 * namespace as the resource's own id, so a resource declared inside
 * `Namespace.push("Site")` with `renamedFrom("Worker")` claims the former
 * FQN `Site/Worker`.
 *
 * Renamed more than once? List every former id, MOST RECENT FIRST — the
 * planner checks them in declaration order and migrates from the first
 * matching row.
 *
 * Migration semantics (see Plan's `getPersistedRow`):
 *
 * - No state row at the resource's FQN, a row at a former FQN → the row is
 *   the resource's state. Plan builds the node from it (an update/noop, not
 *   a create) and apply moves the row to the new FQN before any lifecycle
 *   operation runs.
 * - Rows at BOTH FQNs with the same `instanceId` → an interrupted
 *   migration; the leftover former row is dropped (state only — the
 *   physical resource is never touched). ALL former rows sharing the
 *   resource's instanceId are cleaned up in one apply, so a rename chain
 *   with repeated partial failures still converges in a single deploy.
 * - Rows at both FQNs with different `instanceId`s → the former row is some
 *   other resource's (e.g. a new resource reusing the old name after the
 *   rename shipped); it is ignored and handled like any other row.
 * - A former row whose `resourceType` is neither this resource's type nor
 *   one of its registered type-aliases is never migrated — it cannot be
 *   this resource's row, whatever its FQN says.
 * - A former FQN that is still actively declared by another resource is not
 *   a rename and is ignored; two resources claiming the same former FQN is
 *   ambiguous and fails the plan loudly.
 */
export const renamedFrom =
  (...formerIds: [string, ...string[]]) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
    Effect.provideService(effect, RenamePolicy, formerIds);
