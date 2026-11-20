import type * as Alchemist from "alchemy/Alchemist";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import {
  bootstrap as bootstrapAws,
  destroyBootstrap as destroyBootstrapAws,
} from "../AssetsBucket.ts";
import * as AWSCredentials from "../Credentials.ts";
import { AWSEnvironment } from "../Environment.ts";
import * as AWSRegion from "../Region.ts";
import { resolveAwsEnvironment } from "./Environment.ts";

export interface AwsTarget extends Alchemist.Target {
  readonly profile: string;
  readonly region?: string;
}

const environment = Effect.fn(function* (target: AwsTarget) {
  const environment = yield* resolveAwsEnvironment(target);
  const aws = Layer.provideMerge(
    Layer.mergeAll(AWSRegion.fromEnvironment, AWSCredentials.fromEnvironment),
    Layer.succeed(
      AWSEnvironment,
      Effect.succeed({
        accountId: environment.accountId,
        region: environment.region,
        credentials: environment.credentials,
        profile: environment.profile,
      }),
    ),
  );
  return {
    accountId: environment.accountId,
    region: environment.region,
    layer: Layer.provide(aws, environment.config),
  };
});

/** Provision the AWS deployment assets bucket. */
export const bootstrap = Effect.fn("Alchemist.provider.aws.bootstrap")(function* (
  target: AwsTarget,
) {
  const env = yield* environment(target);
  const result = yield* Effect.provide(bootstrapAws(), env.layer);
  return { accountId: env.accountId, region: env.region, ...result };
});

/** Destroy every Alchemy bootstrap bucket in the region. */
export const teardown = Effect.fn("Alchemist.provider.aws.teardown")(function* (target: AwsTarget) {
  const env = yield* environment(target);
  const result = yield* Effect.provide(destroyBootstrapAws(), env.layer);
  return {
    accountId: env.accountId,
    region: env.region,
    destroyed: result.bucketNames,
  };
});
