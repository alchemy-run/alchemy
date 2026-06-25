import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { RuntimeContext } from "../../RuntimeContext.ts";
import type { AnalyticsEngineDataset as AnalyticsEngineDatasetLike } from "./AnalyticsEngineDataset.ts";

/**
 * Bind an {@link AnalyticsEngineDatasetLike} dataset to a Worker and obtain the
 * Effect-native client (`writeDataPoint`, `raw`).
 *
 * `WriteDataset` is a single identifier that is simultaneously the binding's
 * Context tag, its type, and the callable —
 * `yield* Cloudflare.AnalyticsEngineDataset.WriteDataset(dataset)`.
 *
 * @binding
 * @product Analytics Engine
 * @category Observability & Analytics
 *
 * @example Write a data point inside a Worker
 * ```typescript
 * const analytics = yield* Cloudflare.AnalyticsEngineDataset.WriteDataset(Dataset);
 * yield* analytics.writeDataPoint({ blobs: ["signup"] });
 * ```
 */
export interface WriteDataset extends Binding.Service<
  WriteDataset,
  "Cloudflare.AnalyticsEngineDataset.WriteDataset",
  (
    dataset: AnalyticsEngineDatasetLike,
  ) => Effect.Effect<AnalyticsEngineDatasetClient>
> {}

export const WriteDataset = Binding.Service<WriteDataset>(
  "Cloudflare.AnalyticsEngineDataset.WriteDataset",
);

export interface AnalyticsEngineDataPoint {
  indexes?: string[];
  blobs?: string[];
  doubles?: number[];
}

export interface RuntimeAnalyticsEngineDataset {
  writeDataPoint(dataPoint: AnalyticsEngineDataPoint): void;
}

export class AnalyticsEngineDatasetError extends Data.TaggedError(
  "AnalyticsEngineDatasetError",
)<{
  message: string;
  cause: Error;
}> {}

export interface AnalyticsEngineDatasetClient {
  raw: Effect.Effect<RuntimeAnalyticsEngineDataset, never, RuntimeContext>;
  writeDataPoint(
    dataPoint: AnalyticsEngineDataPoint,
  ): Effect.Effect<void, AnalyticsEngineDatasetError, RuntimeContext>;
}
