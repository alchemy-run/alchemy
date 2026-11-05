import * as omics from "@distilled.cloud/aws/omics";
import * as Binding from "alchemy/Binding";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { makeOmicsResourceHttpBinding } from "./BindingHttp.ts";
import type { ReferenceStore } from "./ReferenceStore.ts";

export interface GetReferenceRequest extends Omit<omics.GetReferenceRequest, "referenceStoreId"> {}

/**
 * Runtime binding for `omics:GetReference`.
 *
 * Bind this operation to a `ReferenceStore` to get a callable that streams the bytes of a reference file part — the
 * store/workflow id is injected automatically and the action is granted on the
 * bound resource. Provide the implementation with
 * `Effect.provide(AWS.Omics.GetReferenceHttp)`.
 * ### References
 * **Example:** Bind GetReference to a ReferenceStore
 * ```typescript
 * // init
 * const getReference = yield* AWS.Omics.GetReference(store);
 * // runtime
 * const result = yield* getReference({});
 * ```
 *
 * @binding
 */
export interface GetReference extends Binding.Service<
  GetReference,
  "AWS.Omics.GetReference",
  (
    store: ReferenceStore,
  ) => Effect.Effect<
    (
      request?: GetReferenceRequest,
    ) => Effect.Effect<omics.GetReferenceResponse, omics.GetReferenceError>
  >
> {}

export const GetReference = Binding.Service<GetReference>("AWS.Omics.GetReference");

export const GetReferenceHttp = Layer.effect(
  GetReference,
  makeOmicsResourceHttpBinding({
    tag: "AWS.Omics.GetReference",
    operation: omics.getReference,
    actions: ["omics:GetReference"],
    key: "referenceStoreId",
    id: (store: ReferenceStore) => store.referenceStoreId,
    arn: (store: ReferenceStore) => store.referenceStoreArn,
  }),
);
