import * as AWS from "@alchemy.run/aws";
import * as Test from "@alchemy.run/test/Alchemy";
import * as Effect from "effect/Effect";
import { missingName } from "../../lookup.ts";
import { expectAllMissing } from "../lookup.ts";

const { test } = Test.make({ providers: AWS.providers() });

const tags = ["provider:aws", "provider:aws:mediaconvert", "live"];

// A lookup of a resource that doesn't exist fails the deploy with
// LookupNotFoundError (job template, preset, queue).
test.provider(
  "a lookup of a missing resource fails the deploy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const name = missingName(stack.stage);
      yield* expectAllMissing(stack, {
        "missing-job-template": AWS.MediaConvert.JobTemplate.lookup({ jobTemplateName: name })
          .jobTemplateName,
        "missing-preset": AWS.MediaConvert.Preset.lookup({ presetName: name }).presetName,
        "missing-queue": AWS.MediaConvert.Queue.lookup({ queueName: name }).queueName,
      });
    }),
  { tags, timeout: 180_000 },
);
