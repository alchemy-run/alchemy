import { ConfigError } from "@distilled.cloud/core/errors";
import {
  Credentials,
  DEFAULT_ANALYTICS_BASE_URL,
  DEFAULT_TOOLBOX_BASE_URL,
} from "@distilled.cloud/daytona/Credentials";
import { lazyCredentials } from "alchemy/Auth/Resolve";
import * as Layer from "effect/Layer";
import { DAYTONA_AUTH_PROVIDER_NAME, type DaytonaResolvedCredentials } from "./AuthProvider.ts";

export {
  Credentials,
  CredentialsFromEnv,
  DEFAULT_ANALYTICS_BASE_URL,
  DEFAULT_API_BASE_URL,
  DEFAULT_TOOLBOX_BASE_URL,
} from "@distilled.cloud/daytona/Credentials";

/**
 * A `Credentials` layer that resolves Daytona credentials through the
 * Alchemy AuthProvider for the current profile.
 */
export const fromAuthProvider = () =>
  Layer.effect(
    Credentials,
    lazyCredentials<DaytonaResolvedCredentials, ConfigError>()(
      DAYTONA_AUTH_PROVIDER_NAME,
      (creds) => ({
        apiKey: creds.token,
        apiBaseUrl: creds.apiBaseUrl,
        analyticsBaseUrl: DEFAULT_ANALYTICS_BASE_URL,
        toolboxBaseUrl: DEFAULT_TOOLBOX_BASE_URL,
        organizationId: creds.organizationId,
      }),
      { expiresAt: (creds) => creds.expires },
    ),
  );
