import * as AWS from "@alchemy.run/aws";
import { AWSEnvironment } from "@alchemy.run/aws/Environment";
import * as Test from "@alchemy.run/test/Alchemy";
import * as Effect from "effect/Effect";
import { missingName } from "../../lookup.ts";
import { expectAllMissing } from "../lookup.ts";

const { test } = Test.make({ providers: AWS.providers() });

const tags = ["provider:aws", "provider:aws:costexplorer", "live"];

// A lookup of a resource that doesn't exist fails the deploy with
// LookupNotFoundError (anomaly monitor, cost category).
test.provider(
  "a lookup of a missing resource fails the deploy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const name = missingName(stack.stage);
      const { accountId, region } = yield* AWSEnvironment.current;
      yield* expectAllMissing(stack, {
        "missing-anomaly-monitor": AWS.CostExplorer.AnomalyMonitor.lookup({
          monitorArn: `arn:aws:ce::${accountId}:anomalymonitor/11111111-1111-4111-8111-111111111111`,
        }).monitorArn,
        "missing-cost-category": AWS.CostExplorer.CostCategory.lookup({
          costCategoryArn: `arn:aws:ce::${accountId}:costcategory/11111111-1111-4111-8111-111111111111`,
        }).costCategoryArn,
      });
    }),
  { tags, timeout: 180_000 },
);
