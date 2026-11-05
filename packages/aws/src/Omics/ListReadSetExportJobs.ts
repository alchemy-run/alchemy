import * as omics from "@distilled.cloud/aws/omics";
import * as Binding from "alchemy/Binding";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { makeOmicsResourceHttpBinding } from "./BindingHttp.ts";
import type { SequenceStore } from "./SequenceStore.ts";

export interface ListReadSetExportJobsRequest extends Omit<
  omics.ListReadSetExportJobsRequest,
  "sequenceStoreId"
> {}

/**
 * Runtime binding for `omics:ListReadSetExportJobs`.
 *
 * Bind this operation to a `SequenceStore` to get a callable that lists the read-set export jobs for the store — the
 * store/workflow id is injected automatically and the action is granted on the
 * bound resource. Provide the implementation with
 * `Effect.provide(AWS.Omics.ListReadSetExportJobsHttp)`.
 * ### Read Sets
 * **Example:** Bind ListReadSetExportJobs to a SequenceStore
 * ```typescript
 * // init
 * const listReadSetExportJobs = yield* AWS.Omics.ListReadSetExportJobs(store);
 * // runtime
 * const result = yield* listReadSetExportJobs({});
 * ```
 *
 * @binding
 */
export interface ListReadSetExportJobs extends Binding.Service<
  ListReadSetExportJobs,
  "AWS.Omics.ListReadSetExportJobs",
  (
    store: SequenceStore,
  ) => Effect.Effect<
    (
      request?: ListReadSetExportJobsRequest,
    ) => Effect.Effect<omics.ListReadSetExportJobsResponse, omics.ListReadSetExportJobsError>
  >
> {}

export const ListReadSetExportJobs = Binding.Service<ListReadSetExportJobs>(
  "AWS.Omics.ListReadSetExportJobs",
);

export const ListReadSetExportJobsHttp = Layer.effect(
  ListReadSetExportJobs,
  makeOmicsResourceHttpBinding({
    tag: "AWS.Omics.ListReadSetExportJobs",
    operation: omics.listReadSetExportJobs,
    actions: ["omics:ListReadSetExportJobs"],
    key: "sequenceStoreId",
    id: (store: SequenceStore) => store.sequenceStoreId,
    arn: (store: SequenceStore) => store.sequenceStoreArn,
  }),
);
