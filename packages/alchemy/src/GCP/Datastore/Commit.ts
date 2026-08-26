import type * as datastore from "@distilled.cloud/gcp/datastore_v1";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { RuntimeContext } from "../../RuntimeContext.ts";
import type { Indexe } from "./Indexe.ts";

export interface CommitRequest extends Omit<
  datastore.CommitProjectsRequest,
  "projectId"
> {
  /** Project id. Defaults to the bound index's project. */
  projectId?: string;
}

/**
 * Runtime binding for Datastore `projects.commit`.
 *
 * Bind this operation to a {@link Indexe} in a Function/Action init
 * phase. Provide {@link CommitHttp}. The bound index supplies the
 * project id; mutations run against the default Datastore-mode database.
 *
 * ### Committing Mutations
 * **Example:** Upsert an entity
 * ```typescript
 * const commit = yield* GCP.Datastore.Commit(index);
 * const result = yield* commit({
 *   body: {
 *     mode: "NON_TRANSACTIONAL",
 *     mutations: [
 *       {
 *         upsert: {
 *           key: { path: [{ kind: "Task", name: "t1" }] },
 *           properties: { title: { stringValue: "Ship" } },
 *         },
 *       },
 *     ],
 *   },
 * });
 * ```
 *
 * @binding
 * @product GCP
 * @category Datastore
 */
export interface Commit extends Binding.Service<
  Commit,
  "GCP.Datastore.Commit",
  (
    index: Indexe,
  ) => Effect.Effect<
    (
      request: CommitRequest,
    ) => Effect.Effect<
      datastore.CommitResponse,
      datastore.CommitProjectsError,
      RuntimeContext
    >
  >
> {}

export const Commit = Binding.Service<Commit>("GCP.Datastore.Commit");
