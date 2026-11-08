import { Credentials } from "@distilled.cloud/boat-dev/Credentials";
import { ConfigError } from "@distilled.cloud/core/errors";
import { lazyCredentials } from "alchemy/Auth/Resolve";
import * as Layer from "effect/Layer";
import { BOAT_AUTH_PROVIDER_NAME, type BoatResolvedCredentials } from "./AuthProvider.ts";

export {
  Credentials,
  CredentialsFromEnv,
  DEFAULT_API_BASE_URL,
  fromApiKey,
} from "@distilled.cloud/boat-dev/Credentials";

/**
 * Build Boat `Credentials` that resolve through the Alchemy AuthProvider:
 * `BOAT_API_KEY` when set, otherwise the selected profile. Resolution is
 * deferred until the first API call, so building the provider layers never
 * needs a profile.
 */
export const fromAuthProvider = () =>
  Layer.effect(
    Credentials,
    lazyCredentials<BoatResolvedCredentials, ConfigError>()(BOAT_AUTH_PROVIDER_NAME, (creds) => ({
      apiKey: creds.apiKey,
      apiBaseUrl: creds.apiBaseUrl,
    })),
  );
