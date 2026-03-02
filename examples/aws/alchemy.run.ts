import { AWS, Stack, Stage } from "alchemy-effect";
import * as Credentials from "distilled-aws/Credentials";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import JobFunction from "./src/JobFunction.ts";

const AWS_REGION = Config.string("AWS_REGION").pipe(
  Config.withDefault("us-west-2"),
);

const AWS_PROFILE = Config.string("AWS_PROFILE").pipe(
  Config.withDefault("default"),
);

const awsConfig = Layer.effect(
  AWS.StageConfig,
  Effect.gen(function* () {
    const stage = yield* Stage;

    if (stage === "prod") {
      return {
        // example of how to hard-code AWS accounts based on stage
        account: "123456789012",
        region: "us-west-2",
      };
    }

    const profileName = yield* AWS_PROFILE;
    const profile = yield* Credentials.loadProfile(profileName);
    if (!profile.sso_account_id) {
      return yield* Effect.die(
        `AWS SSO Profile '${profileName}' is missing sso_account_id configuration`,
      );
    }
    return AWS.StageConfig.of({
      profile: profileName,
      account: profile.sso_account_id,
      region: profile.region ?? (yield* AWS_REGION),
    });
  }),
);

export const stack = Stack.make(
  "Job",
  Effect.gen(function* () {
    const func = yield* JobFunction;
    const bucket = yield* AWS.S3.Bucket("JobsBucket");
    return {
      url: func.functionUrl,
      bucketArn: bucket.bucketArn,
    };
  }).pipe(Effect.provide(Layer.provide(AWS.providers(), awsConfig))),
);

export default stack;
