// TEMPORARY debug probe — exercises the data-plane ops locally via distilled
// to surface the exact error the Lambda fixture hits. Deleted after debugging.
import * as AWS from "@/AWS";
import { Asset, AssetModel } from "@/AWS/IoTSiteWise";
import * as Test from "@/Test/Vitest";
import * as sitewise from "@distilled.cloud/aws/iotsitewise";
import { expect } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";

const { test } = Test.make({ providers: AWS.providers() });

test.provider(
  "probe: batchPut + getValue + aggregates against a live asset",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const { asset } = yield* stack.deploy(
        Effect.gen(function* () {
          const model = yield* AssetModel("ProbePumpModel", {
            assetModelProperties: [
              {
                name: "Temperature",
                dataType: "DOUBLE",
                unit: "Celsius",
                type: { measurement: {} },
              },
            ],
            tags: { fixture: "iotsitewise-probe" },
          });
          const asset = yield* Asset("ProbePump", {
            assetModelId: model.assetModelId,
            tags: { fixture: "iotsitewise-probe" },
          });
          return { asset };
        }),
      );

      const described = yield* sitewise.describeAsset({
        assetId: asset.assetId,
      });
      const propertyId = described.assetProperties.find(
        (p) => p.name === "Temperature",
      )?.id!;
      expect(propertyId).toBeTruthy();

      const now = Math.floor(Date.now() / 1000);
      const put = yield* Effect.result(
        sitewise.batchPutAssetPropertyValue({
          entries: [
            {
              entryId: `probe-${now}`,
              assetId: asset.assetId,
              propertyId,
              propertyValues: [
                {
                  value: { doubleValue: 23.5 },
                  timestamp: { timeInSeconds: now },
                  quality: "GOOD",
                },
              ],
            },
          ],
        }),
      );
      yield* Effect.logInfo(
        `PUT RESULT: ${
          Result.isSuccess(put)
            ? JSON.stringify(put.value)
            : `FAILURE ${String(put.failure)}`
        }`,
      );

      const agg = yield* Effect.result(
        sitewise.getAssetPropertyAggregates({
          assetId: asset.assetId,
          propertyId,
          aggregateTypes: ["AVERAGE"],
          resolution: "1m",
          startDate: new Date(Date.now() - 3_600_000),
          endDate: new Date(),
        }),
      );
      yield* Effect.logInfo(
        `AGG RESULT: ${
          Result.isSuccess(agg)
            ? JSON.stringify(agg.value)
            : `FAILURE ${String(agg.failure)}`
        }`,
      );

      const value = yield* Effect.result(
        sitewise.getAssetPropertyValue({ assetId: asset.assetId, propertyId }),
      );
      yield* Effect.logInfo(
        `VALUE RESULT: ${
          Result.isSuccess(value)
            ? JSON.stringify(value.value)
            : `FAILURE ${String(value.failure)}`
        }`,
      );

      yield* stack.destroy();

      expect(Result.isSuccess(put)).toBe(true);
      expect(Result.isSuccess(agg)).toBe(true);
      expect(Result.isSuccess(value)).toBe(true);
    }),
  { timeout: 240_000 },
);
