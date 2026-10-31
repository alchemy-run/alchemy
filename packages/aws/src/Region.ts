import { Credentials } from "@distilled.cloud/aws/Credentials";
import * as Region from "@distilled.cloud/aws/Region";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { AWSEnvironment } from "./Environment.ts";
import { globalRegionOf } from "./Partition.ts";

export { AWS_REGION, type RegionID } from "./Environment.ts";
export { Region } from "@distilled.cloud/aws/Region";

declare module "@distilled.cloud/aws/Region" {
  interface Region {
    readonly kind: "Environment";
  }
}

export const of = (region: string) => Layer.succeed(Region.Region, Effect.succeed(region));

export const fromEnvOrElse = (region: string) =>
  Layer.succeed(Region.Region, Effect.succeed(process.env.AWS_REGION ?? region));

// Deferred with `Effect.suspend` so it does not dereference `AWSEnvironment`
// during module evaluation. `Region.ts` and `Environment.ts` are part of an
// import cycle (AuthProvider → Region → Environment → AuthProvider); touching
// `AWSEnvironment` eagerly at top level hits a temporal-dead-zone error when
// this module is evaluated mid-cycle.
export const CurrentRegion = Effect.suspend(() =>
  AWSEnvironment.use((env) => Effect.map(env, ({ region }) => region)),
);

/**
 * Derive the AWS region from the surrounding {@link AWSEnvironment}.
 */
export const fromEnvironment = Layer.effect(
  Region.Region,
  Effect.gen(function* () {
    const env = yield* AWSEnvironment;
    return Effect.map(env, (env) => env.region);
  }),
);

/**
 * Run `effect` in the global region of the ambient region's partition, where
 * global services such as Cost Explorer or Route 53 Domains serve their
 * control plane: `us-east-1` in `aws`, `eusc-de-east-1` in `aws-eusc`.
 *
 * The ambient region is the provided `Region`, else the credentials' region,
 * as distilled resolves it. With neither, `effect` runs as-is, so a client
 * captured under `withGlobalRegion` keeps the region it was captured with.
 */
export const withGlobalRegion = <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
  Effect.gen(function* () {
    const region = yield* Effect.serviceOption(Region.Region);
    const credentials = yield* Effect.serviceOption(Credentials);
    const current = Option.isSome(region)
      ? region.value
      : Option.isSome(credentials)
        ? credentials.value.pipe(
            Effect.map(({ region }) => region),
            Effect.mapError(
              (cause) =>
                new Region.MissingRegion({
                  message: `Could not read the region from the credentials: ${cause.message}`,
                }),
            ),
          )
        : undefined;
    return yield* current === undefined
      ? effect
      : effect.pipe(
          Effect.provideService(
            Region.Region,
            Effect.map(current, (region) => globalRegionOf(region) as Region.RegionName),
          ),
        );
  });
