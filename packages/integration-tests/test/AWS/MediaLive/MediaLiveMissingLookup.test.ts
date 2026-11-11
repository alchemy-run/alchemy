import * as AWS from "@alchemy.run/aws";
import * as Test from "@alchemy.run/test/Alchemy";
import * as Effect from "effect/Effect";
import { missingName } from "../../lookup.ts";
import { expectAllMissing } from "../lookup.ts";

const { test } = Test.make({ providers: AWS.providers() });

const tags = ["provider:aws", "provider:aws:medialive", "live"];

// A lookup of a resource that doesn't exist fails the deploy with
// LookupNotFoundError (channel, input, input security group).
test.provider(
  "a lookup of a missing resource fails the deploy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const name = missingName(stack.stage);
      yield* expectAllMissing(stack, {
        "missing-channel": AWS.MediaLive.Channel.lookup({ name: name }).channelId,
        "missing-input": AWS.MediaLive.Input.lookup({ name: name }).inputId,
        "missing-input-security-group": AWS.MediaLive.InputSecurityGroup.lookup({
          inputSecurityGroupId: "1234567",
        }).inputSecurityGroupId,
      });
    }),
  { tags, timeout: 180_000 },
);
