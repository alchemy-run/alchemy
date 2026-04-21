import * as Region from "@distilled.cloud/aws/Region";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { AWSEnvironment } from "./Environment.ts";

export { Region } from "@distilled.cloud/aws/Region";
export { AWS_REGION, type RegionID } from "./Environment.ts";

export const of = (region: string) => Layer.succeed(Region.Region, region);

export const fromEnvOrElse = (region: string) =>
  Layer.succeed(Region.Region, process.env.AWS_REGION ?? region);

/**
 * Derive the AWS region from the surrounding {@link AWSEnvironment}.
 */
export const fromEnvironment = Layer.effect(
  Region.Region,
  Effect.map(AWSEnvironment.asEffect(), (env) => env.region),
);
