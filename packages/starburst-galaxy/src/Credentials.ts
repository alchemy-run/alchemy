import { ConfigError } from "@distilled.cloud/core/errors";
import {
  type ClientCredentials,
  type Config,
  Credentials,
  makeClientCredentials,
} from "@distilled.cloud/starburst-galaxy/Credentials";
import { lazyCredentials } from "alchemy/Auth/Resolve";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as SynchronizedRef from "effect/SynchronizedRef";
import {
  STARBURST_GALAXY_AUTH_PROVIDER_NAME,
  type StarburstGalaxyResolvedCredentials,
} from "./AuthProvider.ts";

export {
  Credentials,
  CredentialsFromEnv,
  fromAccessToken,
  fromClientCredentials,
} from "@distilled.cloud/starburst-galaxy/Credentials";

/**
 * The deploying profile's API client (domain, client ID and secret), as
 * the AuthProvider resolves it. `Credentials` exchanges it for access
 * tokens; bindings hand it to their host (see `StarburstGalaxyBindings`).
 */
export class DeployClient extends Context.Service<
  DeployClient,
  Effect.Effect<ClientCredentials, ConfigError>
>()("StarburstGalaxy/DeployClient") {}

interface TokenCache {
  readonly client: ClientCredentials;
  readonly resolve: Effect.Effect<Config, ConfigError>;
}

const sameClient = (a: ClientCredentials, b: ClientCredentials) =>
  a.domain === b.domain &&
  a.clientId === b.clientId &&
  Redacted.value(a.clientSecret) === Redacted.value(b.clientSecret);

/**
 * Access tokens for whichever client `resolveClient` names: one SDK token
 * cache (refreshed shortly before Galaxy's ten-minute expiry) per client,
 * so a token is never sent to another account's domain after the client
 * changes (`alchemy profile edit`, or a host's rebound credentials).
 */
export const tokensFor = <R>(resolveClient: Effect.Effect<ClientCredentials, ConfigError, R>) =>
  Effect.gen(function* () {
    const http = yield* HttpClient.HttpClient;
    const cache = yield* SynchronizedRef.make(Option.none<TokenCache>());
    const tokenFor = (client: ClientCredentials) =>
      SynchronizedRef.modifyEffect(cache, (current) =>
        Option.isSome(current) && sameClient(current.value.client, client)
          ? Effect.succeed([current.value.resolve, current] as const)
          : makeClientCredentials(client).pipe(
              Effect.provideService(HttpClient.HttpClient, http),
              Effect.map((resolve) => [resolve, Option.some({ client, resolve })] as const),
            ),
      ).pipe(Effect.flatten);
    return Effect.flatMap(resolveClient, tokenFor);
  });

/**
 * The current profile's client credentials, or `STARBURST_GALAXY_*` in CI,
 * resolved on first use.
 */
export const deployClientFromAuthProvider = () =>
  Layer.effect(
    DeployClient,
    lazyCredentials<StarburstGalaxyResolvedCredentials, ConfigError>()(
      STARBURST_GALAXY_AUTH_PROVIDER_NAME,
      (creds): ClientCredentials => ({
        domain: creds.domain,
        clientId: creds.clientId,
        clientSecret: creds.clientSecret,
      }),
    ),
  );

/**
 * Build a `Credentials` layer from the Alchemy AuthProvider: the current
 * profile's client credentials, or `STARBURST_GALAXY_*` in CI, exchanged
 * for access tokens by the SDK's token cache. It also provides
 * {@link DeployClient}.
 */
export const fromAuthProvider = () =>
  Layer.effect(
    Credentials,
    Effect.gen(function* () {
      const resolveClient = yield* DeployClient;
      return yield* tokensFor(resolveClient);
    }),
  ).pipe(Layer.provideMerge(deployClientFromAuthProvider()));
