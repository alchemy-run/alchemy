import * as AWS from "@alchemy.run/aws";
import { AWSEnvironment } from "@alchemy.run/aws/Environment";
import * as Test from "@alchemy.run/test/Alchemy";
import * as Effect from "effect/Effect";
import { missingName } from "../../lookup.ts";
import { expectAllMissing } from "../lookup.ts";

const { test } = Test.make({ providers: AWS.providers() });

const tags = ["provider:aws", "provider:aws:ivs", "live"];

// A lookup of a resource that doesn't exist fails the deploy with
// LookupNotFoundError (channel, playback key pair, playback restriction policy, recording configuration, stream key).
test.provider(
  "a lookup of a missing resource fails the deploy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const name = missingName(stack.stage);
      const { accountId, region } = yield* AWSEnvironment.current;
      yield* expectAllMissing(stack, {
        "missing-channel": AWS.IVS.Channel.lookup({
          channelArn: `arn:aws:ivs:${region}:${accountId}:channel/AAAAAAAAAAAA`,
        }).channelArn,
        "missing-playback-key-pair": AWS.IVS.PlaybackKeyPair.lookup({
          playbackKeyPairArn: `arn:aws:ivs:${region}:${accountId}:playback-key/AAAAAAAAAAAA`,
        }).playbackKeyPairName,
        "missing-playback-restriction-policy": AWS.IVS.PlaybackRestrictionPolicy.lookup({
          playbackRestrictionPolicyArn: `arn:aws:ivs:${region}:${accountId}:playback-restriction-policy/AAAAAAAAAAAA`,
        }).playbackRestrictionPolicyArn,
        "missing-recording-configuration": AWS.IVS.RecordingConfiguration.lookup({
          recordingConfigurationArn: `arn:aws:ivs:${region}:${accountId}:recording-configuration/AAAAAAAAAAAA`,
        }).recordingConfigurationArn,
        "missing-stream-key": AWS.IVS.StreamKey.lookup({
          streamKeyArn: `arn:aws:ivs:${region}:${accountId}:stream-key/AAAAAAAAAAAA`,
        }).streamKeyArn,
      });
    }),
  { tags, timeout: 180_000 },
);
