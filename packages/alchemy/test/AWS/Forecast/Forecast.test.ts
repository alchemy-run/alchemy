import * as AWS from "@/AWS";
import { Dataset, DatasetGroup } from "@/AWS/Forecast";
import * as Test from "@/Test/Vitest";
import * as forecast from "@distilled.cloud/aws/forecast";
import { expect } from "@effect/vitest";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: AWS.providers() });

class DatasetGroupStillExists extends Data.TaggedError(
  "DatasetGroupStillExists",
)<{ readonly arn: string }> {}

const assertDatasetGroupDeleted = (arn: string) =>
  forecast.describeDatasetGroup({ DatasetGroupArn: arn }).pipe(
    Effect.flatMap(() => Effect.fail(new DatasetGroupStillExists({ arn }))),
    Effect.catchTag("ResourceNotFoundException", () =>
      Effect.succeed(undefined),
    ),
    Effect.retry({
      while: (e) => e._tag === "DatasetGroupStillExists",
      schedule: Schedule.spaced("3 seconds").pipe(
        Schedule.both(Schedule.recurs(20)),
      ),
    }),
  );

// Ungated typed-error probe: proves credentials reach Forecast and the SDK
// decodes a typed error. In an entitled account a missing dataset surfaces as
// ResourceNotFoundException; the standing test account has no forecast:* grant,
// so it surfaces as the shared AccessDeniedException. Either way the boundary
// is a typed tag — the full lifecycle below is gated.
test.provider(
  "describeDataset on a nonexistent ARN fails with a typed error",
  () =>
    Effect.gen(function* () {
      const region = yield* yield* AWS.Region;
      const error = yield* Effect.flip(
        forecast.describeDataset({
          DatasetArn: `arn:aws:forecast:${region}:000000000000:dataset/does_not_exist`,
        }),
      );
      expect(
        ["ResourceNotFoundException", "AccessDeniedException"].includes(
          error._tag,
        ),
      ).toBe(true);
    }),
);

// Forecast datasets and dataset groups are cheap metadata objects that
// provision quickly, but the standing test account has no forecast:* IAM
// grant, so the live lifecycle is gated behind AWS_TEST_ML=1 and runs
// unchanged in an entitled account. The expensive training work (predictors,
// forecasts, import jobs) is out of scope.
test.provider.skipIf(!process.env.AWS_TEST_ML)(
  "create, attach, and destroy a dataset and dataset group",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const dataset = yield* Dataset("Demand", {
            domain: "CUSTOM",
            datasetType: "TARGET_TIME_SERIES",
            dataFrequency: "D",
            schema: {
              attributes: [
                { attributeName: "item_id", attributeType: "string" },
                { attributeName: "timestamp", attributeType: "timestamp" },
                { attributeName: "target_value", attributeType: "float" },
              ],
            },
            tags: { Environment: "test" },
          });
          const group = yield* DatasetGroup("Sales", {
            domain: "CUSTOM",
            datasetArns: [dataset.datasetArn],
            tags: { Environment: "test" },
          });
          return { dataset, group };
        }),
      );

      expect(created.dataset.datasetArn).toContain(":dataset/");
      expect(created.dataset.datasetType).toBe("TARGET_TIME_SERIES");
      expect(created.group.datasetGroupArn).toContain(":dataset-group/");
      expect(created.group.domain).toBe("CUSTOM");

      // Out-of-band verification via distilled.
      const describedDataset = yield* forecast.describeDataset({
        DatasetArn: created.dataset.datasetArn,
      });
      expect(describedDataset.Domain).toBe("CUSTOM");
      expect(describedDataset.DataFrequency).toBe("D");

      const describedGroup = yield* forecast.describeDatasetGroup({
        DatasetGroupArn: created.group.datasetGroupArn,
      });
      expect(describedGroup.DatasetArns).toContain(created.dataset.datasetArn);

      const groupTags = yield* forecast.listTagsForResource({
        ResourceArn: created.group.datasetGroupArn,
      });
      expect(
        groupTags.Tags?.some(
          (t) => t.Key === "alchemy::id" && t.Value === "Sales",
        ),
      ).toBe(true);

      // Update: detach the dataset and change tags in place.
      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          const dataset = yield* Dataset("Demand", {
            domain: "CUSTOM",
            datasetType: "TARGET_TIME_SERIES",
            dataFrequency: "D",
            schema: {
              attributes: [
                { attributeName: "item_id", attributeType: "string" },
                { attributeName: "timestamp", attributeType: "timestamp" },
                { attributeName: "target_value", attributeType: "float" },
              ],
            },
            tags: { Environment: "test" },
          });
          const group = yield* DatasetGroup("Sales", {
            domain: "CUSTOM",
            datasetArns: [],
            tags: { Environment: "test", Extra: "yes" },
          });
          return { dataset, group };
        }),
      );
      expect(updated.group.datasetGroupArn).toBe(created.group.datasetGroupArn);

      const reDescribedGroup = yield* forecast.describeDatasetGroup({
        DatasetGroupArn: created.group.datasetGroupArn,
      });
      expect(reDescribedGroup.DatasetArns ?? []).not.toContain(
        created.dataset.datasetArn,
      );
      const updatedTags = yield* forecast.listTagsForResource({
        ResourceArn: created.group.datasetGroupArn,
      });
      expect(
        updatedTags.Tags?.some((t) => t.Key === "Extra" && t.Value === "yes"),
      ).toBe(true);

      // Destroy and verify deletion out-of-band.
      yield* stack.destroy();
      yield* assertDatasetGroupDeleted(created.group.datasetGroupArn);
      const datasetError = yield* Effect.flip(
        forecast.describeDataset({ DatasetArn: created.dataset.datasetArn }),
      );
      expect(datasetError._tag).toBe("ResourceNotFoundException");
    }),
  { timeout: 300_000 },
);
