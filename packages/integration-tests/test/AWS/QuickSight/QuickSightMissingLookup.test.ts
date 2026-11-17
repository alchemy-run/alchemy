import * as AWS from "@alchemy.run/aws";
import * as Test from "@alchemy.run/test/Alchemy";
import * as Effect from "effect/Effect";
import { missingName } from "../../lookup.ts";
import { expectAllMissing } from "../lookup.ts";

const { test } = Test.make({ providers: AWS.providers() });

const tags = ["provider:aws", "provider:aws:quicksight", "live"];

// A lookup of a resource that doesn't exist fails the deploy with
// LookupNotFoundError (analysis, dashboard, data set, data source).
// The testing account can't use QuickSight; an entitled account sets the gate.
test.provider.skipIf(!process.env.AWS_TEST_QUICKSIGHT)(
  "a lookup of a missing resource fails the deploy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const name = missingName(stack.stage);
      yield* expectAllMissing(stack, {
        "missing-analysis": AWS.QuickSight.Analysis.lookup({ analysisId: name }).analysisId,
        "missing-dashboard": AWS.QuickSight.Dashboard.lookup({ dashboardId: name }).dashboardId,
        "missing-data-set": AWS.QuickSight.DataSet.lookup({ dataSetId: name }).dataSetId,
        "missing-data-source": AWS.QuickSight.DataSource.lookup({ dataSourceId: name })
          .dataSourceId,
      });
    }),
  { tags, timeout: 180_000 },
);
