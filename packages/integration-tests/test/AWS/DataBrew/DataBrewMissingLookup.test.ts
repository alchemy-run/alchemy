import * as AWS from "@alchemy.run/aws";
import * as Test from "@alchemy.run/test/Alchemy";
import * as Effect from "effect/Effect";
import { missingName } from "../../lookup.ts";
import { expectAllMissing } from "../lookup.ts";

const { test } = Test.make({ providers: AWS.providers() });

const tags = ["provider:aws", "provider:aws:databrew", "live"];

// A lookup of a resource that doesn't exist fails the deploy with
// LookupNotFoundError (dataset, job, project, recipe, ruleset, schedule).
test.provider(
  "a lookup of a missing resource fails the deploy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const name = missingName(stack.stage);
      yield* expectAllMissing(stack, {
        "missing-dataset": AWS.DataBrew.Dataset.lookup({ datasetName: name }).datasetName,
        "missing-job": AWS.DataBrew.Job.lookup({ jobName: name }).jobName,
        "missing-project": AWS.DataBrew.Project.lookup({ projectName: name }).projectName,
        "missing-recipe": AWS.DataBrew.Recipe.lookup({ recipeName: name }).recipeName,
        "missing-ruleset": AWS.DataBrew.Ruleset.lookup({ rulesetName: name }).rulesetName,
        "missing-schedule": AWS.DataBrew.Schedule.lookup({ scheduleName: name }).scheduleName,
      });
    }),
  { tags, timeout: 180_000 },
);
