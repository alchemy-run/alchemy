import * as sitewise from "@distilled.cloud/aws/iotsitewise";
import * as Binding from "alchemy/Binding";
import type * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type { Asset } from "./Asset.ts";
import { makeSiteWiseAssetHttpBinding } from "./BindingHttp.ts";

/**
 * Request for {@link DescribeAsset}. The bound asset's id is injected
 * automatically.
 */
export interface DescribeAssetRequest extends Omit<sitewise.DescribeAssetRequest, "assetId"> {}

/**
 * Runtime binding for `iotsitewise:DescribeAsset` — read the bound asset's
 * full description (including its properties with their service-assigned
 * ids and names) from a deployed Lambda or Task. Use it to resolve a
 * property's id by name before reading or ingesting values.
 *
 * ### Describing the Bound Asset
 * Provide the `DescribeAssetHttp` implementation layer on the Function
 * effect, bind the asset in the init phase, then call the returned client
 * at runtime.
 *
 * **Example:** Resolve a Property Id by Name
 * ```typescript
 * // init
 * const describeAsset = yield* AWS.IoTSiteWise.DescribeAsset(asset);
 *
 * // runtime
 * const described = yield* describeAsset();
 * const propertyId = described.assetProperties.find(
 *   (p) => p.name === "Temperature",
 * )?.id;
 * // on the Function effect:
 * // .pipe(Effect.provide(AWS.IoTSiteWise.DescribeAssetHttp))
 * ```
 *
 * @binding
 */
export interface DescribeAsset extends Binding.Service<
  DescribeAsset,
  "AWS.IoTSiteWise.DescribeAsset",
  (
    asset: Asset,
  ) => Effect.Effect<
    (
      request?: DescribeAssetRequest,
    ) => Effect.Effect<sitewise.DescribeAssetResponse, sitewise.DescribeAssetError>
  >
> {}
export const DescribeAsset = Binding.Service<DescribeAsset>("AWS.IoTSiteWise.DescribeAsset");

export const DescribeAssetHttp = Layer.effect(
  DescribeAsset,
  makeSiteWiseAssetHttpBinding({
    capability: "DescribeAsset",
    iamActions: ["iotsitewise:DescribeAsset"],
    operation: sitewise.describeAsset,
    prepare: (request: DescribeAssetRequest | undefined, assetId) => ({
      ...request,
      assetId,
    }),
  }),
);
