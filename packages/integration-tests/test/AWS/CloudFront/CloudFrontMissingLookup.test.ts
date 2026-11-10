import * as AWS from "@alchemy.run/aws";
import * as Test from "@alchemy.run/test/Alchemy";
import * as Effect from "effect/Effect";
import { missingName } from "../../lookup.ts";
import { expectAllMissing } from "../lookup.ts";

const { test } = Test.make({ providers: AWS.providers() });

const tags = ["provider:aws", "provider:aws:cloudfront", "live"];

// A lookup of a resource that doesn't exist fails the deploy with
// LookupNotFoundError (VPC origin, distribution, key group, public key, realtime log config).
test.provider(
  "a lookup of a missing resource fails the deploy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const name = missingName(stack.stage);
      yield* expectAllMissing(stack, {
        "missing-distribution": AWS.CloudFront.Distribution.lookup({ distributionId: name })
          .distributionId,
        "missing-key-group": AWS.CloudFront.KeyGroup.lookup({ name: name }).keyGroupId,
        "missing-public-key": AWS.CloudFront.PublicKey.lookup({ name: name }).publicKeyId,
        "missing-realtime-log-config": AWS.CloudFront.RealtimeLogConfig.lookup({ name: name }).arn,
        "missing-vpc-origin": AWS.CloudFront.VpcOrigin.lookup({
          vpcOriginId: "vo_AbCdEfGhIjKlMnOpQrStUv",
        }).vpcOriginId,
      });
    }),
  { tags, timeout: 180_000 },
);
