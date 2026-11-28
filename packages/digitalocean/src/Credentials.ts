import { Credentials } from "@distilled.cloud/digitalocean/Credentials";
import { lazyCredentials } from "alchemy/Auth/Resolve";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import {
  DIGITALOCEAN_AUTH_PROVIDER_NAME,
  type DigitalOceanResolvedCredentials,
} from "./AuthProvider.ts";

export {
  Credentials,
  CredentialsFromEnv,
  DEFAULT_API_BASE_URL,
  fromApiKey,
  type Config as CredentialsConfig,
} from "@distilled.cloud/digitalocean/Credentials";

/**
 * Build a `Credentials` layer that resolves DigitalOcean credentials via the
 * Alchemy AuthProvider using the configured profile (defaults to "default",
 * overridable with the `ALCHEMY_PROFILE` env/config value).
 *
 * Maps onto `@distilled.cloud/digitalocean`'s `{ apiKey, apiBaseUrl }` shape.
 */
export const fromAuthProvider = () =>
  Layer.effect(
    Credentials,
    // `Credentials` has no error channel: a failed resolution dies, and the
    // engine reports it as `CredentialsRequired`.
    lazyCredentials<DigitalOceanResolvedCredentials>()(
      DIGITALOCEAN_AUTH_PROVIDER_NAME,
      (creds) => ({
        apiKey: creds.apiToken,
        apiBaseUrl: creds.apiBaseUrl,
        spacesAccessKeyId: creds.spacesAccessKeyId,
        spacesSecretAccessKey: creds.spacesSecretAccessKey,
      }),
    ).pipe(Effect.map(Effect.orDie)),
  );
