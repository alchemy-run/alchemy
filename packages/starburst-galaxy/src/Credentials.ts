import { ConfigError } from "@distilled.cloud/core/errors";
import {
  type ClientCredentials,
  type Config,
  Credentials,
  makeClientCredentials,
} from "@distilled.cloud/starburst-galaxy/Credentials";
import { lazyCredentials } from "alchemy/Auth/Resolve";
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

interface TokenCache {
  readonly client: ClientCredentials;
  readonly resolve: Effect.Effect<Config, ConfigError>;
}

/**
 * Build a `Credentials` layer from the Alchemy AuthProvider: the current
 * profile's client credentials, or `STARBURST_GALAXY_*` in CI. The client
 * credentials are exchanged for an access token by the SDK's token cache,
 * which refreshes it shortly before its ten-minute expiry; a different
 * client (after `alchemy profile edit`) gets a cache of its own, so a token
 * is never sent to another account's domain.
 */
export const fromAuthProvider = () =>
  Layer.effect(
    Credentials,
    Effect.gen(function* () {
      const http = yield* HttpClient.HttpClient;
      const resolveClient = yield* lazyCredentials<
        StarburstGalaxyResolvedCredentials,
        ConfigError
      >()(STARBURST_GALAXY_AUTH_PROVIDER_NAME, (creds): ClientCredentials => ({
        domain: creds.domain,
        clientId: creds.clientId,
        clientSecret: creds.clientSecret,
      }));
      const cache = yield* SynchronizedRef.make(Option.none<TokenCache>());
      const tokenFor = (client: ClientCredentials) =>
        SynchronizedRef.modifyEffect(cache, (current) =>
          Option.isSome(current) &&
          current.value.client.domain === client.domain &&
          current.value.client.clientId === client.clientId &&
          Redacted.value(current.value.client.clientSecret) === Redacted.value(client.clientSecret)
            ? Effect.succeed([current.value.resolve, current] as const)
            : makeClientCredentials(client).pipe(
                Effect.provideService(HttpClient.HttpClient, http),
                Effect.map((resolve) => [resolve, Option.some({ client, resolve })] as const),
              ),
        ).pipe(Effect.flatten);
      return Effect.flatMap(resolveClient, tokenFor);
    }),
  );
