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
 * // was `Worker("Website/Worker", ...)` in a previous release:
 * const worker = yield* Worker("Website", props).pipe(
 *   renamedFrom("Website/Worker"),
 * );
 * ```
 *
 * A bare-string former id behaves exactly like the resource's own `id`
 * argument: it resolves against the ambient namespace, so a resource
 * declared inside `Namespace.push("Site")` with `renamedFrom("Worker")`
 * claims the former FQN `Site/Worker`. When the resource moved BETWEEN
 * namespaces, pass the absolute form instead — `renamedFrom({ fqn:
 * "Legacy/Worker" })` claims exactly that FQN regardless of the ambient
 * namespace.
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
  (...formerIds: [FormerId, ...FormerId[]]) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
    Effect.provideService(effect, RenamePolicy, formerIds);
