import * as Effect from "effect/Effect";
import {
  AnalyticsEngineDatasetBinding,
  AnalyticsEngineDatasetTag,
} from "./AnalyticsEngineDatasetBinding.ts";

type AnalyticsEngineDatasetTypeId = typeof AnalyticsEngineDatasetTypeId;
const AnalyticsEngineDatasetTypeId =
  "Cloudflare.AnalyticsEngineDataset" as const;

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
 *
 * @example Effect-style worker
 * ```typescript
 * const analytics = yield* Cloudflare.AnalyticsEngineDataset.bind(Analytics);
 * yield* analytics.writeDataPoint({ blobs: ["signup"] });
 * ```
 *
 * @example Effect-style worker with a binding tag
 * ```typescript
 * const Analytics = Cloudflare.AnalyticsEngineDataset("Analytics");
 *
 * class Events extends Cloudflare.AnalyticsEngineDataset.Tag<Events>()(
 *   "Events",
 *   { resource: Analytics },
 * ) {}
 *
 * export default Cloudflare.Worker(
 *   "Worker",
 *   { main: import.meta.filename },
 *   Effect.gen(function* () {
 *     const EventsLive = yield* Events.layer;
 *
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const events = yield* Events;
 *         yield* events.writeDataPoint({ blobs: ["signup"] });
 *         return new Response("ok");
 *       }).pipe(Effect.provide(EventsLive)),
 *     };
 *   }).pipe(Effect.provide(Cloudflare.AnalyticsEngineDatasetBindingLive)),
 * );
 * ```
 */
export type AnalyticsEngineDataset = {
  kind: AnalyticsEngineDatasetTypeId;
  name: string;
  dataset: string;
};

export const isAnalyticsEngineDataset = (
  value: unknown,
): value is AnalyticsEngineDataset =>
  typeof value === "object" &&
  value !== null &&
  "kind" in value &&
  (value as AnalyticsEngineDataset).kind === AnalyticsEngineDatasetTypeId;

export const AnalyticsEngineDataset: {
  (
    name: string,
    props?: AnalyticsEngineDatasetProps,
  ): Effect.Effect<AnalyticsEngineDataset>;
  /**
   * Bind Analytics Engine to the surrounding Worker, returning an
   * Effect-native client with access to the native Workers runtime binding.
   */
  bind: typeof AnalyticsEngineDatasetBinding.bind;
  Tag: typeof AnalyticsEngineDatasetTag;
} = Object.assign(
  Effect.fnUntraced(function* (
    name: string,
    props?: AnalyticsEngineDatasetProps,
  ) {
    return {
      kind: AnalyticsEngineDatasetTypeId,
      name,
      dataset: props?.dataset ?? name,
    } satisfies AnalyticsEngineDataset;
  }),
  {
    bind: AnalyticsEngineDatasetBinding.bind,
    Tag: AnalyticsEngineDatasetTag,
  },
);
