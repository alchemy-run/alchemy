import * as AWS from "@alchemy.run/aws";
import * as Test from "@alchemy.run/test/Alchemy";
import * as Effect from "effect/Effect";
import { missingName } from "../../lookup.ts";
import { expectAllMissing } from "../lookup.ts";

const { test } = Test.make({ providers: AWS.providers() });

const tags = ["provider:aws", "provider:aws:autoscaling", "live"];

// A lookup of a resource that doesn't exist fails the deploy with
// LookupNotFoundError (auto scaling group, launch template).
test.provider(
  "a lookup of a missing resource fails the deploy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const name = missingName(stack.stage);
      yield* expectAllMissing(stack, {
        "missing-auto-scaling-group": AWS.AutoScaling.AutoScalingGroup.lookup({
          autoScalingGroupName: name,
        }).autoScalingGroupArn,
        "missing-launch-template": AWS.AutoScaling.LaunchTemplate.lookup({
          launchTemplateName: name,
        }).launchTemplateId,
      });
    }),
  { tags, timeout: 180_000 },
);
