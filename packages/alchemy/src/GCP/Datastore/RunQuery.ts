import type * as datastore from "@distilled.cloud/gcp/datastore_v1";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { RuntimeContext } from "../../RuntimeContext.ts";
import type { Indexe } from "./Indexe.ts";

export interface RunQueryRequest extends Omit<
  datastore.RunQueryProjectsRequest,
  "projectId"
> {
  /** Project id. Defaults to the bound index's project. */
  projectId?: string;
}

/**
 * Runtime binding for Datastore `projects.runQuery`.
 *
 * Bind this operation to a {@link Indexe} in a Function/Action init
 * phase. Provide {@link RunQueryHttp}. The bound index supplies the
 * project id; queries run against the default Datastore-mode database.
 *
 * ### Querying Entities
 * **Example:** Query a kind
 * ```typescript
 * const runQuery = yield* GCP.Datastore.RunQuery(index);
 * const page = yield* runQuery({
 *   body: { query: { kind: [{ name: "Task" }] } },
 * });
 * ```
 *
 * @binding
 * @product GCP
 * @category Datastore
 */
export interface RunQuery extends Binding.Service<
  RunQuery,
  "GCP.Datastore.RunQuery",
  (
    index: Indexe,
  ) => Effect.Effect<
    (
      request: RunQueryRequest,
    ) => Effect.Effect<
      datastore.RunQueryResponse,
      datastore.RunQueryProjectsError,
      RuntimeContext
    >
  >
> {}

export const RunQuery = Binding.Service<RunQuery>("GCP.Datastore.RunQuery");
