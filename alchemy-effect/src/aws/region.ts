import * as Config from "effect/Config";
import * as Option from "effect/Option";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { App } from "../app.ts";
import { Region, Credentials } from "distilled-aws";

export type RegionID = string;

export const of = (region: string) => Layer.succeed(Region.Region, region);

export const fromEnvOrElse = (region: string) =>
  Layer.succeed(Region.Region, process.env.AWS_REGION ?? region);

export class EnvironmentVariableNotSet extends Data.TaggedError(
  "EnvironmentVariableNotSet",
)<{
  message: string;
  variable: string;
}> {}

export const AWS_REGION = Config.string("AWS_REGION");

const tryGetAWSRegion = () =>
  Config.option(AWS_REGION).pipe(Effect.map(Option.getOrUndefined));

export const fromEnv = () =>
  Layer.effect(
    Region.Region,
    Effect.gen(function* () {
      const region = yield* tryGetAWSRegion();
      if (!region) {
        return yield* Effect.fail(
          new EnvironmentVariableNotSet({
            message: "AWS_REGION is not set",
            variable: "AWS_REGION",
          }),
        );
      }
      return region;
    }),
  );

export class AWSStageConfigRegionMissing extends Data.TaggedError(
  "AWSStageConfigMissing",
)<{
  message: string;
  stage: string;
}> {}

export const fromStageConfig = () =>
  Layer.effect(
    Region.Region,
    Effect.gen(function* () {
      const app = yield* App;
      if (app.config.aws?.region) {
        return app.config.aws.region;
      } else if (app.config.aws?.profile) {
        const profile = yield* Credentials.loadProfile(app.config.aws.profile);
        if (profile.region) {
          return profile.region;
        }
      }
      const region = yield* tryGetAWSRegion();
      if (region) {
        return region;
      }
      return yield* Effect.dieMessage(
        "No AWS region found in stage config, SSO profile, or environment variable",
      );
    }),
  );
