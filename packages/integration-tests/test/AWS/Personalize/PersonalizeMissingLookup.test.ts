import * as AWS from "@alchemy.run/aws";
import { AWSEnvironment } from "@alchemy.run/aws/Environment";
import * as Test from "@alchemy.run/test/Alchemy";
import * as Effect from "effect/Effect";
import { missingName } from "../../lookup.ts";
import { expectAllMissing } from "../lookup.ts";

const { test } = Test.make({ providers: AWS.providers() });

const tags = ["provider:aws", "provider:aws:personalize", "live"];

// A lookup of a resource that doesn't exist fails the deploy with
// LookupNotFoundError (dataset, dataset group, event tracker, schema).
test.provider(
  "a lookup of a missing resource fails the deploy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const name = missingName(stack.stage);
      const { accountId, region } = yield* AWSEnvironment.current;
      yield* expectAllMissing(stack, {
        "missing-dataset": AWS.Personalize.Dataset.lookup({
          datasetArn: `arn:aws:personalize:${region}:${accountId}:dataset/missing-lookup/INTERACTIONS`,
        }).datasetArn,
        "missing-dataset-group": AWS.Personalize.DatasetGroup.lookup({
          datasetGroupArn: `arn:aws:personalize:${region}:${accountId}:dataset-group/missing-lookup`,
        }).datasetGroupArn,
        "missing-event-tracker": AWS.Personalize.EventTracker.lookup({
          eventTrackerArn: `arn:aws:personalize:${region}:${accountId}:event-tracker/aaaaaaaa`,
        }).eventTrackerArn,
        "missing-schema": AWS.Personalize.Schema.lookup({
          schemaArn: `arn:aws:personalize:${region}:${accountId}:schema/missing-lookup`,
        }).schemaArn,
      });
    }),
  { tags, timeout: 180_000 },
);
