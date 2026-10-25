import { Credentials, fromClientSecret } from "@distilled.cloud/azure";
import { ConfigError } from "@distilled.cloud/core/errors";
import * as Graph from "@distilled.cloud/microsoft-graph/Credentials";
import type { AuthError, NeedsReauth } from "alchemy/Auth/AuthProvider";
import { resolveProviderConfig } from "alchemy/Auth/Resolve";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import {
  AZURE_AUTH_PROVIDER_NAME,
  type AzureAuthConfig,
  type AzureResolvedCredentials,
} from "./AuthProvider.ts";

export {
  Credentials,
  CredentialsFromEnv,
  DEFAULT_API_BASE_URL,
  fromClientSecret,
  fromManagedIdentity,
  type Config as CredentialsConfig,
} from "@distilled.cloud/azure";

/**
 * Resolve the Azure service principal for the configured profile (or the
 * CI environment). The resolved value is cached for the layer's lifetime.
 */
export const resolveAzureCredentials = Effect.gen(function* () {
  const { profileName, resolve } = yield* resolveProviderConfig<
    AzureAuthConfig,
    AzureResolvedCredentials
  >(AZURE_AUTH_PROVIDER_NAME);
  const resolved: Effect.Effect<AzureResolvedCredentials, AuthError | NeedsReauth> = resolve;
  return yield* resolved.pipe(
    Effect.mapError(
      (e) =>
        new ConfigError({
          message: `Failed to resolve Azure credentials from ${profileName === undefined ? "the environment" : `profile '${profileName}'`}: ${e.message}`,
        }),
    ),
    Effect.cached,
  );
});

/** The service value a credentials layer holds, built once. */
const serviceOf = <I, S>(tag: Context.Key<I, S>, layer: Layer.Layer<I>) =>
  Layer.build(layer).pipe(
    Effect.scoped,
    Effect.map((context) => Context.get(context, tag)),
  );

/**
 * The `Credentials` layer for `@distilled.cloud/azure`, from the Alchemy
 * AuthProvider: distilled's `fromClientSecret` over the profile's (or CI's)
 * service principal. It mints a token per scope (`tokenFor(scope)`) for ARM
 * and every data plane, caches it, and refreshes it before it expires. The
 * profile is resolved on first use, not when the layer is built.
 */
export const fromAuthProvider = () =>
  Layer.effect(
    Credentials,
    Effect.gen(function* () {
      const resolved = yield* resolveAzureCredentials;
      const config = yield* Effect.cached(
        resolved.pipe(
          Effect.flatMap((sp) =>
            serviceOf(
              Credentials,
              fromClientSecret({
                tenantId: sp.tenantId,
                clientId: sp.clientId,
                clientSecret: sp.clientSecret,
                subscriptionId: sp.subscriptionId,
              }),
            ),
          ),
        ),
      );
      return Effect.flatten(config);
    }),
  );

/**
 * The `Credentials` layer for `@distilled.cloud/microsoft-graph`, from the
 * same service principal as {@link fromAuthProvider}. The `Azure.Entra`
 * resources use it. The principal needs the Graph application permission
 * `Application.ReadWrite.OwnedBy` (or `Application.ReadWrite.All`).
 */
export const graphFromAuthProvider = () =>
  Layer.effect(
    Graph.Credentials,
    Effect.gen(function* () {
      const resolved = yield* resolveAzureCredentials;
      const config = yield* Effect.cached(
        resolved.pipe(
          Effect.flatMap((sp) =>
            serviceOf(
              Graph.Credentials,
              Graph.fromClientSecret({
                tenantId: sp.tenantId,
                clientId: sp.clientId,
                clientSecret: sp.clientSecret,
              }),
            ),
          ),
        ),
      );
      return Effect.flatten(config);
    }),
  );
