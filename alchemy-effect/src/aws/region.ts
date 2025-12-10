import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { App } from "../app.ts";

export class Region extends Context.Tag("AWS::Region")<Region, Region.ID>() {}

export declare namespace Region {
  export type ID = string;
}

export const of = (region: string) => Layer.succeed(Region, region);

export const fromEnvOrElse = (region: string) =>
  Layer.succeed(Region, process.env.AWS_REGION ?? region);

export class EnvironmentVariableNotSet extends Data.TaggedError(
  "EnvironmentVariableNotSet",
)<{
  message: string;
  variable: string;
}> {}

export const fromEnv = () =>
  Layer.effect(
    Region,
    Effect.gen(function* () {
      const region = process.env.AWS_REGION;
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

class AWSStageConfigMissing extends Data.TaggedError("AWSStageConfigMissing")<{
  message: string;
  stage: string;
}> {}

export const fromStageConfig = () =>
  Layer.effect(
    Region,
    Effect.gen(function* () {
      const region = yield* App;
      if (!region.config.aws?.region) {
        return yield* Effect.fail(
          new AWSStageConfigMissing({
            message: "AWS stage config is missing region",
            stage: region.stage,
          }),
        );
      }
      return region.config.aws.region;
    }),
  );
