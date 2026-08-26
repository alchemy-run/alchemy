import type * as datastore from "@distilled.cloud/gcp/datastore_v1";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { RuntimeContext } from "../../RuntimeContext.ts";
import type { Indexe } from "./Indexe.ts";

export interface LookupRequest extends Omit<
  datastore.LookupProjectsRequest,
  "projectId"
> {
  /** Project id. Defaults to the bound index's project. */
  projectId?: string;
}

/**
 * Runtime binding for Datastore `projects.lookup`.
 *
 * Bind this operation to a {@link Indexe} in a Function/Action init
 * phase. Provide {@link LookupHttp}. The bound index supplies the
 * project id; lookups run against the default Datastore-mode database.
 *
 * ### Looking Up Entities
 * **Example:** Lookup by key
 * ```typescript
 * const lookup = yield* GCP.Datastore.Lookup(index);
 * const result = yield* lookup({
 *   body: {
 *     keys: [{ path: [{ kind: "Task", name: "t1" }] }],
 *   },
 * });
 * ```
 *
 * @binding
 * @product GCP
 * @category Datastore
 */
export interface Lookup extends Binding.Service<
  Lookup,
  "GCP.Datastore.Lookup",
  (
    index: Indexe,
  ) => Effect.Effect<
    (
      request: LookupRequest,
    ) => Effect.Effect<
      datastore.LookupResponse,
      datastore.LookupProjectsError,
      RuntimeContext
    >
  >
> {}

export const Lookup = Binding.Service<Lookup>("GCP.Datastore.Lookup");
