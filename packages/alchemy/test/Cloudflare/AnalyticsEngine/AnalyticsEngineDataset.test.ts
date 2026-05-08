import * as Cloudflare from "@/Cloudflare";
import type { AnalyticsEngineDataPoint } from "@/Cloudflare/AnalyticsEngine";
import { WorkerEnvironment } from "@/Cloudflare/Workers/Worker";
import { Self } from "@/Self";
import * as Test from "@/Test/Vitest";
import { expect } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

const { test } = Test.make({ providers: Layer.empty });

test(
  "writes data points through the Effect-native runtime binding",
  Effect.gen(function* () {
    const dataPoints: AnalyticsEngineDataPoint[] = [];
    const dataset = yield* Cloudflare.AnalyticsEngineDataset("Events", {
      dataset: "app-events",
    });

    yield* Effect.gen(function* () {
      const analytics = yield* Cloudflare.AnalyticsEngineDataset.bind(dataset);
      yield* analytics.writeDataPoint({
        indexes: ["account-1"],
        blobs: ["signup"],
        doubles: [1],
      });
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          Cloudflare.AnalyticsEngineDatasetBindingLive,
          Layer.succeed(
            Cloudflare.AnalyticsEngineDatasetBindingPolicy,
            () => Effect.void,
          ),
          Layer.succeed(WorkerEnvironment, {
            Events: {
              writeDataPoint: (dataPoint: AnalyticsEngineDataPoint) => {
                dataPoints.push(dataPoint);
              },
            },
          }),
        ),
      ),
      Effect.provideService(Self, {
        Type: "Cloudflare.Worker",
        LogicalId: "AnalyticsWorker",
      }),
    );

    expect(dataPoints).toEqual([
      {
        indexes: ["account-1"],
        blobs: ["signup"],
        doubles: [1],
      },
    ]);
  }),
);
