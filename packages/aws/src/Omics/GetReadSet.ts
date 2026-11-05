import * as omics from "@distilled.cloud/aws/omics";
import * as Binding from "alchemy/Binding";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { makeOmicsResourceHttpBinding } from "./BindingHttp.ts";
import type { SequenceStore } from "./SequenceStore.ts";

export interface GetReadSetRequest extends Omit<omics.GetReadSetRequest, "sequenceStoreId"> {}

/**
 * Runtime binding for `omics:GetReadSet`.
 *
 * Bind this operation to a `SequenceStore` to get a callable that streams the bytes of a read set file part — the
 * store/workflow id is injected automatically and the action is granted on the
 * bound resource. Provide the implementation with
 * `Effect.provide(AWS.Omics.GetReadSetHttp)`.
 * ### Read Sets
 * **Example:** Bind GetReadSet to a SequenceStore
 * ```typescript
 * // init
 * const getReadSet = yield* AWS.Omics.GetReadSet(store);
 * // runtime
 * const result = yield* getReadSet({});
 * ```
 *
 * @binding
 */
export interface GetReadSet extends Binding.Service<
  GetReadSet,
  "AWS.Omics.GetReadSet",
  (
    store: SequenceStore,
  ) => Effect.Effect<
    (request?: GetReadSetRequest) => Effect.Effect<omics.GetReadSetResponse, omics.GetReadSetError>
  >
> {}

export const GetReadSet = Binding.Service<GetReadSet>("AWS.Omics.GetReadSet");

export const GetReadSetHttp = Layer.effect(
  GetReadSet,
  makeOmicsResourceHttpBinding({
    tag: "AWS.Omics.GetReadSet",
    operation: omics.getReadSet,
    actions: ["omics:GetReadSet"],
    key: "sequenceStoreId",
    id: (store: SequenceStore) => store.sequenceStoreId,
    arn: (store: SequenceStore) => store.sequenceStoreArn,
  }),
);
