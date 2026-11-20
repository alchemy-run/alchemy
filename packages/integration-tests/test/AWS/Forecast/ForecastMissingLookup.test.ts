import * as AWS from "@alchemy.run/aws";
import { AWSEnvironment } from "@alchemy.run/aws/Environment";
import * as Test from "@alchemy.run/test/Alchemy";
import * as Effect from "effect/Effect";
import { missingName } from "../../lookup.ts";
import { expectAllMissing } from "../lookup.ts";

const { test } = Test.make({ providers: AWS.providers() });

const tags = ["provider:aws", "provider:aws:forecast", "live"];

// A lookup of a resource that doesn't exist fails the deploy with
// LookupNotFoundError (dataset, dataset group).
// The testing account can't use Forecast; an entitled account sets the gate.
test.provider.skipIf(!process.env.AWS_TEST_FORECAST)(
  "a lookup of a missing resource fails the deploy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const name = missingName(stack.stage);
      const { accountId, region } = yield* AWSEnvironment.current;
      yield* expectAllMissing(stack, {
        "missing-dataset": AWS.Forecast.Dataset.lookup({
          datasetArn: `arn:aws:forecast:${region}:${accountId}:dataset/missing_lookup`,
        }).datasetArn,
        "missing-dataset-group": AWS.Forecast.DatasetGroup.lookup({
          datasetGroupArn: `arn:aws:forecast:${region}:${accountId}:dataset-group/missing_lookup`,
        }).datasetGroupArn,
      });
    }),
  { tags, timeout: 180_000 },
);
