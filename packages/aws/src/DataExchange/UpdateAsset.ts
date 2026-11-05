import * as dataexchange from "@distilled.cloud/aws/dataexchange";
import * as Binding from "alchemy/Binding";
import type * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { makeRevisionHttpBinding, revisionAssetArns } from "./BindingHttp.ts";
import type { Revision } from "./Revision.ts";

/**
 * Runtime binding for `dataexchange:UpdateAsset`.
 *
 * Renames an asset of the bound revision (the asset name is the S3 key
 * used when subscribers export it). The data set and revision ids are
 * injected from the binding.
 * Provide the implementation with
 * `Effect.provide(AWS.DataExchange.UpdateAssetHttp)`.
 * ### Managing Assets
 * **Example:** Rename An Imported Asset
 * ```typescript
 * const updateAsset = yield* AWS.DataExchange.UpdateAsset(revision);
 *
 * // runtime
 * yield* updateAsset({ AssetId: assetId, Name: "prices/2026-07-14.csv" });
 * ```
 *
 * @binding
 */
export interface UpdateAsset extends Binding.Service<
  UpdateAsset,
  "AWS.DataExchange.UpdateAsset",
  (
    revision: Revision,
  ) => Effect.Effect<
    (
      request: Omit<dataexchange.UpdateAssetRequest, "DataSetId" | "RevisionId">,
    ) => Effect.Effect<dataexchange.UpdateAssetResponse, dataexchange.UpdateAssetError>
  >
> {}
export const UpdateAsset = Binding.Service<UpdateAsset>("AWS.DataExchange.UpdateAsset");

export const UpdateAssetHttp = Layer.effect(
  UpdateAsset,
  makeRevisionHttpBinding({
    tag: "AWS.DataExchange.UpdateAsset",
    operation: dataexchange.updateAsset,
    actions: ["dataexchange:UpdateAsset"],
    resources: revisionAssetArns,
  }),
);
