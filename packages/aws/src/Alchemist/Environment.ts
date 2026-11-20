import * as Auth from "@distilled.cloud/aws/Auth";
import { AuthProvidersLive, getAuthProvider, presentEnvironment } from "alchemy/Auth/AuthProvider";
import { resolveProviderConfig } from "alchemy/Auth/Resolve";
import { loadConfigProvider } from "alchemy/Util/ConfigProvider";
import * as ConfigProvider from "effect/ConfigProvider";
import * as EffectConsole from "effect/Console";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import {
  AwsAuth,
  AWS_AUTH_PROVIDER_NAME,
  getAccountId,
  silentConsole,
  type AwsResolvedCredentials,
} from "../AuthProvider.ts";

export interface AwsEnvironmentTarget {
  readonly profile: string;
  readonly region?: string;
  readonly envFile?: string;
}

const applyAwsTargetRegion = (
  targetRegion: string | undefined,
  resolved: {
    readonly accountId: string;
    readonly region: string;
    readonly credentials: AwsResolvedCredentials["credentials"];
    readonly profile: string | undefined;
  },
) => {
  const region = targetRegion ?? resolved.region;
  return {
    accountId: resolved.accountId,
    region,
    credentials: resolved.credentials.pipe(Effect.map((value) => ({ ...value, region }))),
    profile: resolved.profile,
  };
};

/**
 * Resolve bootstrap credentials without conflating the AWS CLI profile passed
 * to `--aws-profile` with Alchemy's own profile selector.
 */
export const resolveAwsEnvironment = Effect.fn(function* (target: AwsEnvironmentTarget) {
  const configProvider = yield* loadConfigProvider(Option.fromNullishOr(target.envFile));
  const config = ConfigProvider.layer(configProvider);
  const auth = AwsAuth.pipe(Layer.provideMerge(AuthProvidersLive), Layer.provideMerge(config));
  const provider = yield* getAuthProvider<{ method: string }, AwsResolvedCredentials>(
    AWS_AUTH_PROVIDER_NAME,
  ).pipe(Effect.provide(auth));
  const environment = yield* presentEnvironment(provider.environment).pipe(Effect.provide(auth));

  if (environment !== undefined) {
    const resolved = yield* resolveProviderConfig<{ method: string }, AwsResolvedCredentials>(
      AWS_AUTH_PROVIDER_NAME,
    ).pipe(Effect.provide(auth));
    const credentials = yield* resolved.resolve.pipe(Effect.provide(auth));
    return {
      ...applyAwsTargetRegion(target.region, {
        accountId: credentials.accountId,
        region: credentials.region,
        credentials: credentials.credentials,
        profile: undefined,
      }),
      config,
    };
  }

  const profile = yield* Auth.loadProfile(target.profile);
  const credentialServices =
    yield* Effect.context<Effect.Services<ReturnType<typeof Auth.loadProfileCredentials>>>();
  const credentials = Auth.loadProfileCredentials(target.profile).pipe(
    Effect.provideService(EffectConsole.Console, silentConsole),
    Effect.provide(credentialServices),
  );
  const accountId = profile.sso_account_id ?? (yield* Effect.flatMap(credentials, getAccountId));
  return {
    ...applyAwsTargetRegion(target.region, {
      accountId,
      region: profile.region ?? "us-east-1",
      credentials,
      profile: target.profile,
    }),
    config,
  };
});
