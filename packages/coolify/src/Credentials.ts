import { Credentials } from "@distilled.cloud/coolify/Credentials";
import { ConfigError } from "@distilled.cloud/core/errors";
import { lazyCredentials } from "alchemy/Auth/Resolve";
import * as Layer from "effect/Layer";
import { COOLIFY_AUTH_PROVIDER_NAME, type CoolifyResolvedCredentials } from "./AuthProvider.ts";

export {
  Credentials,
  CredentialsFromEnv,
  DEFAULT_API_BASE_URL,
} from "@distilled.cloud/coolify/Credentials";

/**
 * Build a `Credentials` layer that resolves Coolify credentials through the
 * current Alchemy profile, or from `COOLIFY_TOKEN` / `COOLIFY_API_BASE_URL`
 * in CI.
 */
export const fromAuthProvider = () =>
  Layer.effect(
    Credentials,
    lazyCredentials<CoolifyResolvedCredentials, ConfigError>()(
      COOLIFY_AUTH_PROVIDER_NAME,
      (creds) => ({
        apiKey: creds.token,
        apiBaseUrl: creds.apiBaseUrl,
      }),
    ),
  );
