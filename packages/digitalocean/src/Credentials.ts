import { ConfigError } from "@distilled.cloud/core/errors";
import { Credentials } from "@distilled.cloud/digitalocean/Credentials";
import { lazyCredentials } from "alchemy/Auth/Resolve";
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
    lazyCredentials<DigitalOceanResolvedCredentials, ConfigError>()(
      DIGITALOCEAN_AUTH_PROVIDER_NAME,
      (creds) => ({ apiKey: creds.apiToken, apiBaseUrl: creds.apiBaseUrl }),
    ),
  );
