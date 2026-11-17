import * as AWS from "@alchemy.run/aws";
import * as Test from "@alchemy.run/test/Alchemy";
import * as Effect from "effect/Effect";
import { missingName } from "../../lookup.ts";
import { expectAllMissing } from "../lookup.ts";

const { test } = Test.make({ providers: AWS.providers() });

const tags = ["provider:aws", "provider:aws:amp", "live"];

// A lookup of a resource that doesn't exist fails the deploy with
// LookupNotFoundError (anomaly detector, rule groups namespace, scraper, workspace).
test.provider(
  "a lookup of a missing resource fails the deploy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const name = missingName(stack.stage);
      yield* expectAllMissing(stack, {
        "missing-anomaly-detector": AWS.AMP.AnomalyDetector.lookup({
          workspaceId: name,
          alias: name,
        }).workspaceId,
        "missing-rule-groups-namespace": AWS.AMP.RuleGroupsNamespace.lookup({
          workspaceId: name,
          name: name,
        }).workspaceId,
        "missing-scraper": AWS.AMP.Scraper.lookup({ scraperId: name }).scraperId,
        "missing-workspace": AWS.AMP.Workspace.lookup({ workspaceId: name }).workspaceId,
      });
    }),
  { tags, timeout: 180_000 },
);
