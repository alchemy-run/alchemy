import * as sitewise from "@distilled.cloud/aws/iotsitewise";
import * as Binding from "alchemy/Binding";
import type * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type { Asset } from "./Asset.ts";
import { makeSiteWiseAssetHttpBinding } from "./BindingHttp.ts";

/**
 * Request for {@link GetAssetPropertyValueHistory}. The bound asset's id is
 * injected automatically.
 */
export interface GetAssetPropertyValueHistoryRequest extends Omit<
  sitewise.GetAssetPropertyValueHistoryRequest,
  "assetId"
> {}

/**
 * Runtime binding for `iotsitewise:GetAssetPropertyValueHistory` — read the
 * historical timestamp-quality-values of one property of the bound asset
 * over a time range from a deployed Lambda or Task.
 *
 * ### Reading Value History
 * Provide the `GetAssetPropertyValueHistoryHttp` implementation layer on
 * the Function effect, bind the asset in the init phase, then call the
 * returned client at runtime. Page through large ranges with `nextToken`.
 *
 * **Example:** Read the Last Hour of Values
 * ```typescript
 * // init
 * const getHistory = yield* AWS.IoTSiteWise.GetAssetPropertyValueHistory(asset);
 *
 * // runtime
 * const now = yield* Effect.sync(() => new Date());
 * const { assetPropertyValueHistory } = yield* getHistory({
 *   propertyId,
 *   startDate: new Date(now.getTime() - 3_600_000),
 *   endDate: now,
 *   timeOrdering: "DESCENDING",
 * });
 * // on the Function effect:
 * // .pipe(Effect.provide(AWS.IoTSiteWise.GetAssetPropertyValueHistoryHttp))
 * ```
 *
 * @binding
 */
export interface GetAssetPropertyValueHistory extends Binding.Service<
  GetAssetPropertyValueHistory,
  "AWS.IoTSiteWise.GetAssetPropertyValueHistory",
  (
    asset: Asset,
  ) => Effect.Effect<
    (
      request: GetAssetPropertyValueHistoryRequest,
    ) => Effect.Effect<
      sitewise.GetAssetPropertyValueHistoryResponse,
      sitewise.GetAssetPropertyValueHistoryError
    >
  >
> {}
export const GetAssetPropertyValueHistory = Binding.Service<GetAssetPropertyValueHistory>(
  "AWS.IoTSiteWise.GetAssetPropertyValueHistory",
);

export const GetAssetPropertyValueHistoryHttp = Layer.effect(
  GetAssetPropertyValueHistory,
  makeSiteWiseAssetHttpBinding({
    capability: "GetAssetPropertyValueHistory",
    iamActions: ["iotsitewise:GetAssetPropertyValueHistory"],
    operation: sitewise.getAssetPropertyValueHistory,
    prepare: (request: GetAssetPropertyValueHistoryRequest, assetId) => ({
      ...request,
      assetId,
    }),
  }),
);
