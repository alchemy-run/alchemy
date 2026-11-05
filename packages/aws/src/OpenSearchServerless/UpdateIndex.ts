import * as aoss from "@distilled.cloud/aws/opensearchserverless";
import * as Binding from "alchemy/Binding";
import type * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { makeAossCollectionHttpBinding } from "./BindingHttp.ts";
import type { Collection } from "./Collection.ts";

/**
 * Runtime binding for the `UpdateIndex` operation scoped to one collection
 * (IAM actions `aoss:UpdateIndex` + `aoss:APIAccessAll` on the collection ARN).
 *
 * Updates an index's schema in the bound {@link Collection} — add new fields
 * or change field mappings at runtime. The calling principal must also be
 * granted `aoss:UpdateIndex` on the index pattern by a data
 * {@link AccessPolicy}. Provide the implementation with
 * `Effect.provide(AWS.OpenSearchServerless.UpdateIndexHttp)`.
 * ### Managing Indexes at Runtime
 * **Example:** Add a field to an index
 * ```typescript
 * const updateIndex = yield* AWS.OpenSearchServerless.UpdateIndex(collection);
 *
 * yield* updateIndex({
 *   indexName: "tenant-42",
 *   indexSchema: {
 *     mappings: { properties: { title: { type: "text" } } },
 *   },
 * });
 * ```
 *
 * @binding
 */
export interface UpdateIndex extends Binding.Service<
  UpdateIndex,
  "AWS.OpenSearchServerless.UpdateIndex",
  (
    collection: Collection,
  ) => Effect.Effect<
    (
      request: Omit<aoss.UpdateIndexRequest, "id">,
    ) => Effect.Effect<aoss.UpdateIndexResponse, aoss.UpdateIndexError>
  >
> {}
export const UpdateIndex = Binding.Service<UpdateIndex>("AWS.OpenSearchServerless.UpdateIndex");

export const UpdateIndexHttp = Layer.effect(
  UpdateIndex,
  makeAossCollectionHttpBinding({
    tag: "AWS.OpenSearchServerless.UpdateIndex",
    operation: aoss.updateIndex,
    // IAM checks both: `aoss:UpdateIndex` for the API call, and
    // `aoss:APIAccessAll` because the service reads the index through the
    // collection's data plane ("Access denied to head index" without it).
    // IAM has no narrower data-plane action; per-index permissions belong in
    // the collection's AccessPolicy.
    actions: ["aoss:UpdateIndex", "aoss:APIAccessAll"],
  }),
);
