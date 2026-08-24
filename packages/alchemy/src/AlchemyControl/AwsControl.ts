import * as Auth from "@distilled.cloud/aws/Auth";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import {
  bootstrap as bootstrapAws,
  destroyBootstrap as destroyBootstrapAws,
} from "../AWS/Bootstrap.ts";
import * as AWSCredentials from "../AWS/Credentials.ts";
import { AWSEnvironment } from "../AWS/Environment.ts";
import * as AWSRegion from "../AWS/Region.ts";
import { loadConfigProvider } from "../Util/ConfigProvider.ts";
import type { ControlContext } from "./ControlContext.ts";
import { internalize } from "./ControlEffect.ts";
import { ControlInternalError, type AwsTarget } from "./Surface.ts";

export const makeAwsControl = Effect.gen(function* () {
  const context = yield* Effect.context<ControlContext>();

  const environment = Effect.fn(function* (target: AwsTarget) {
    const ssoProfile = yield* Auth.loadProfile(target.profile);
    if (!ssoProfile.sso_account_id) {
      return yield* Effect.fail(
        new ControlInternalError({
          message: `AWS SSO profile '${target.profile}' is missing sso_account_id`,
        }),
      );
    }
    const region = target.region ?? ssoProfile.region ?? "us-east-1";
    const awsEnvironment = Layer.succeed(
      AWSEnvironment,
      Effect.succeed({
        accountId: ssoProfile.sso_account_id,
        region,
        credentials: Auth.loadProfileCredentials(target.profile).pipe(
          Effect.provide(context),
        ),
        profile: target.profile,
      }),
    );
    const aws = Layer.provideMerge(
      Layer.mergeAll(AWSRegion.fromEnvironment, AWSCredentials.fromEnvironment),
      awsEnvironment,
    );
    return {
      accountId: ssoProfile.sso_account_id,
      region,
      layer: Layer.provide(
        aws,
        ConfigProvider.layer(
          yield* loadConfigProvider(Option.fromNullishOr(target.envFile)),
        ),
      ),
    };
  });

  return {
    bootstrap: (target: AwsTarget) =>
      internalize(
        Effect.gen(function* () {
          const env = yield* environment(target);
          const result = yield* bootstrapAws().pipe(Effect.provide(env.layer));
          return { accountId: env.accountId, region: env.region, ...result };
        }).pipe(Effect.provide(context)),
      ),
    teardown: (target: AwsTarget) =>
      internalize(
        Effect.gen(function* () {
          const env = yield* environment(target);
          const result = yield* destroyBootstrapAws().pipe(
            Effect.provide(env.layer),
          );
          return {
            accountId: env.accountId,
            region: env.region,
            destroyed: result.bucketNames,
          };
        }).pipe(Effect.provide(context)),
      ),
  };
});

/** AWS bootstrap and teardown operations. */
export class AwsControl extends Context.Service<
  AwsControl,
  Effect.Success<typeof makeAwsControl>
>()("alchemy/AlchemyControl/Aws") {}

/** Live AWS control implementation. */
export const AwsControlLive = Layer.effect(AwsControl, makeAwsControl);
