import * as Effect from "effect/Effect";

type AnalyticsEngineDatasetTypeId = "Cloudflare.AnalyticsEngineDataset";
const AnalyticsEngineDatasetTypeId: AnalyticsEngineDatasetTypeId =
  "Cloudflare.AnalyticsEngineDataset";

export type AnalyticsEngineDatasetProps = {
  /**
   * Dataset name. If omitted, the logical ID is used.
   */
  dataset?: string;
};

/**
 * A Cloudflare Workers Analytics Engine dataset binding.
 *
 * Analytics Engine datasets are configured as Worker bindings. The binding
 * exposes `writeDataPoint()` at runtime and does not require separate
 * provisioning through the Cloudflare API.
 *
 * @resource
 *
 * @section Binding to a Worker
 * @example Basic Analytics Engine binding
 * ```typescript
 * const Analytics = yield* Cloudflare.AnalyticsEngineDataset("Analytics", {
 *   dataset: "app-events",
 * });
 *
 * export const Worker = Cloudflare.Worker("Worker", {
 *   main: "./src/worker.ts",
 *   bindings: { Analytics },
 * });
 * ```
 */
export type AnalyticsEngineDataset = {
  Type: AnalyticsEngineDatasetTypeId;
  name: string;
  dataset: string;
};

export const isAnalyticsEngineDataset = (
  value: unknown,
): value is AnalyticsEngineDataset =>
  typeof value === "object" &&
  value !== null &&
  "Type" in value &&
  (value as AnalyticsEngineDataset).Type === AnalyticsEngineDatasetTypeId;

export const AnalyticsEngineDataset = Effect.fnUntraced(function* (
  name: string,
  props?: AnalyticsEngineDatasetProps,
) {
  return {
    Type: AnalyticsEngineDatasetTypeId,
    name,
    dataset: props?.dataset ?? name,
  } satisfies AnalyticsEngineDataset;
});
