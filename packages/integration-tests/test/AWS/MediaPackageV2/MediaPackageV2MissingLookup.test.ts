import * as AWS from "@alchemy.run/aws";
import * as Test from "@alchemy.run/test/Alchemy";
import * as Effect from "effect/Effect";
import { missingName } from "../../lookup.ts";
import { expectAllMissing } from "../lookup.ts";

const { test } = Test.make({ providers: AWS.providers() });

const tags = ["provider:aws", "provider:aws:mediapackagev2", "live"];

// A lookup of a resource that doesn't exist fails the deploy with
// LookupNotFoundError (channel, channel group, origin endpoint).
test.provider(
  "a lookup of a missing resource fails the deploy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const name = missingName(stack.stage);
      yield* expectAllMissing(stack, {
        "missing-channel": AWS.MediaPackageV2.Channel.lookup({
          channelGroupName: name,
          channelName: name,
        }).channelGroupName,
        "missing-channel-group": AWS.MediaPackageV2.ChannelGroup.lookup({ channelGroupName: name })
          .channelGroupName,
        "missing-origin-endpoint": AWS.MediaPackageV2.OriginEndpoint.lookup({
          channelGroupName: name,
          channelName: name,
          originEndpointName: name,
        }).channelGroupName,
      });
    }),
  { tags, timeout: 180_000 },
);
