import { ConfigError } from "@distilled.cloud/core/errors";
import { Credentials } from "@distilled.cloud/infisical/Credentials";
import { lazyCredentials } from "alchemy/Auth/Resolve";
import * as Layer from "effect/Layer";
import { INFISICAL_AUTH_PROVIDER_NAME, type InfisicalResolvedCredentials } from "./AuthProvider.ts";

export {
  Credentials,
  CredentialsFromEnv,
  DEFAULT_API_BASE_URL,
  fromApiKey,
} from "@distilled.cloud/infisical/Credentials";

/** Resolve Infisical credentials on first use through the selected Alchemy auth provider. */
export const fromAuthProvider = () =>
  Layer.effect(
    Credentials,
    lazyCredentials<InfisicalResolvedCredentials, ConfigError>()(
      INFISICAL_AUTH_PROVIDER_NAME,
      ({ token, apiBaseUrl }) => ({ apiKey: token, apiBaseUrl }),
      // Cache a minted access token only until it expires.
      { expiresAt: ({ expires }) => expires },
    ),
  );
