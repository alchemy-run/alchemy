import * as AWS from "@/AWS";
import { Dataset, DatasetGroup, Schema } from "@/AWS/Personalize";
import * as Test from "@/Test/Vitest";
import * as personalize from "@distilled.cloud/aws/personalize";
import { expect } from "@effect/vitest";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: AWS.providers() });

const INTERACTIONS_SCHEMA = JSON.stringify({
  type: "record",
  name: "Interactions",
  namespace: "com.amazonaws.personalize.schema",
  fields: [
    { name: "USER_ID", type: "string" },
    { name: "ITEM_ID", type: "string" },
    { name: "TIMESTAMP", type: "long" },
  ],
  version: "1.0",
});

class DatasetGroupStillExists extends Data.TaggedError(
  "DatasetGroupStillExists",
)<{ readonly arn: string }> {}

const assertDatasetGroupDeleted = (arn: string) =>
  personalize.describeDatasetGroup({ datasetGroupArn: arn }).pipe(
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

// Ungated typed-error probe: proves credentials reach Personalize and the SDK
// decodes a typed error. In an entitled account a missing group surfaces as
// ResourceNotFoundException; the standing test account has no personalize:*
// grant, so it surfaces as the shared AccessDeniedException. Either way the
// boundary is a typed tag — the full lifecycle below is gated.
test.provider(
  "describeDatasetGroup on a nonexistent ARN fails with a typed error",
  () =>
    Effect.gen(function* () {
      const region = yield* yield* AWS.Region;
      const error = yield* Effect.flip(
        personalize.describeDatasetGroup({
          datasetGroupArn: `arn:aws:personalize:${region}:000000000000:dataset-group/does-not-exist`,
        }),
      );
      expect(
        ["ResourceNotFoundException", "AccessDeniedException"].includes(
          error._tag,
        ),
      ).toBe(true);
    }),
);

// Personalize schemas, dataset groups, and datasets are cheap metadata
// objects that provision quickly, but the standing test account has no
// personalize:* IAM grant, so the live lifecycle is gated behind AWS_TEST_ML=1
// and runs unchanged in an entitled account. The expensive training work
// (solutions, campaigns, import jobs) is out of scope.
test.provider.skipIf(!process.env.AWS_TEST_ML)(
  "create and destroy a schema, dataset group, and dataset",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const schema = yield* Schema("Interactions", {
            schema: INTERACTIONS_SCHEMA,
          });
          const group = yield* DatasetGroup("Group", {
            tags: { Environment: "test" },
          });
          const dataset = yield* Dataset("Dataset", {
            schemaArn: schema.schemaArn,
            datasetGroupArn: group.datasetGroupArn,
            datasetType: "Interactions",
            tags: { Environment: "test" },
          });
          return { schema, group, dataset };
        }),
      );

      expect(created.schema.schemaArn).toContain(":schema/");
      expect(created.group.datasetGroupArn).toContain(":dataset-group/");
      expect(created.group.status).toBe("ACTIVE");
      expect(created.dataset.datasetArn).toContain(":dataset/");
      expect(created.dataset.status).toBe("ACTIVE");
      expect(created.dataset.datasetType).toBe("Interactions");

      // Out-of-band verification via distilled.
      const describedSchema = yield* personalize.describeSchema({
        schemaArn: created.schema.schemaArn,
      });
      expect(JSON.parse(describedSchema.schema!.schema!)).toEqual(
        JSON.parse(INTERACTIONS_SCHEMA),
      );

      const describedGroup = yield* personalize.describeDatasetGroup({
        datasetGroupArn: created.group.datasetGroupArn,
      });
      expect(describedGroup.datasetGroup?.status).toBe("ACTIVE");

      const groupTags = yield* personalize.listTagsForResource({
        resourceArn: created.group.datasetGroupArn,
      });
      expect(
        groupTags.tags?.some(
          (t) => t.tagKey === "alchemy::id" && t.tagValue === "Group",
        ),
      ).toBe(true);

      const describedDataset = yield* personalize.describeDataset({
        datasetArn: created.dataset.datasetArn,
      });
      expect(describedDataset.dataset?.datasetType).toBe("Interactions");
      expect(describedDataset.dataset?.schemaArn).toBe(
        created.schema.schemaArn,
      );

      // Update: change the dataset group's tags in place.
      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          const schema = yield* Schema("Interactions", {
            schema: INTERACTIONS_SCHEMA,
          });
          const group = yield* DatasetGroup("Group", {
            tags: { Environment: "test", Extra: "yes" },
          });
          const dataset = yield* Dataset("Dataset", {
            schemaArn: schema.schemaArn,
            datasetGroupArn: group.datasetGroupArn,
            datasetType: "Interactions",
            tags: { Environment: "test" },
          });
          return { schema, group, dataset };
        }),
      );
      // Stable identifiers are preserved across the update.
      expect(updated.group.datasetGroupArn).toBe(created.group.datasetGroupArn);
      expect(updated.dataset.datasetArn).toBe(created.dataset.datasetArn);

      const updatedTags = yield* personalize.listTagsForResource({
        resourceArn: created.group.datasetGroupArn,
      });
      expect(
        updatedTags.tags?.some(
          (t) => t.tagKey === "Extra" && t.tagValue === "yes",
        ),
      ).toBe(true);

      // Destroy and verify deletion out-of-band.
      yield* stack.destroy();
      yield* assertDatasetGroupDeleted(created.group.datasetGroupArn);
      const datasetError = yield* Effect.flip(
        personalize.describeDataset({
          datasetArn: created.dataset.datasetArn,
        }),
      );
      expect(datasetError._tag).toBe("ResourceNotFoundException");
    }),
  { timeout: 300_000 },
);
