import * as AWS from "@alchemy.run/aws";
import { AWSEnvironment } from "@alchemy.run/aws/Environment";
import * as Test from "@alchemy.run/test/Alchemy";
import * as Effect from "effect/Effect";
import { missingName } from "../../lookup.ts";
import { expectAllMissing } from "../lookup.ts";

const { test } = Test.make({ providers: AWS.providers() });

const tags = ["provider:aws", "provider:aws:bedrockdataautomation", "live"];

// A lookup of a resource that doesn't exist fails the deploy with
// LookupNotFoundError (blueprint, data automation library, data automation project).
test.provider(
  "a lookup of a missing resource fails the deploy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const name = missingName(stack.stage);
      const { accountId, region } = yield* AWSEnvironment.current;
      yield* expectAllMissing(stack, {
        "missing-blueprint": AWS.BedrockDataAutomation.Blueprint.lookup({ blueprintName: name })
          .blueprintArn,
        "missing-data-automation-library": AWS.BedrockDataAutomation.DataAutomationLibrary.lookup({
          libraryArn: `arn:aws:bedrock:${region}:${accountId}:data-automation-library/11111111-1111-4111-8111-111111111111`,
        }).libraryArn,
        "missing-data-automation-project": AWS.BedrockDataAutomation.DataAutomationProject.lookup({
          projectName: name,
        }).projectArn,
      });
    }),
  { tags, timeout: 180_000 },
);
