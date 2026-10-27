import { ConfigError } from "@distilled.cloud/core/errors";
import { Credentials } from "@distilled.cloud/entire/Credentials";
import { lazyCredentials } from "alchemy/Auth/Resolve";
import * as Layer from "effect/Layer";
import { ENTIRE_AUTH_PROVIDER_NAME, type EntireResolvedCredentials } from "./AuthProvider.ts";

export {
  Credentials,
  CredentialsFromEnv,
  DEFAULT_API_BASE_URL,
  DEFAULT_CORE_BASE_URL,
} from "@distilled.cloud/entire/Credentials";

/**
 * Build a `Credentials` layer that resolves Entire credentials through the
 * Alchemy AuthProvider for the current profile. The OAuth access token is
 * cached until shortly before it expires, so a long deploy or `alchemy dev`
 * session re-resolves (and refreshes) it instead of reusing a dead token.
 */
export const fromAuthProvider = () =>
  Layer.effect(
    Credentials,
    lazyCredentials<EntireResolvedCredentials, ConfigError>()(
      ENTIRE_AUTH_PROVIDER_NAME,
      (creds) => ({
        token: creds.token,
        coreBaseUrl: creds.coreBaseUrl,
        apiBaseUrl: creds.apiBaseUrl,
      }),
      { expiresAt: (creds) => creds.expires },
    ),
  );
