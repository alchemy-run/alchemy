import { ConfigError } from "@distilled.cloud/core/errors";
import { Credentials } from "@distilled.cloud/mux/Credentials";
import { lazyCredentials } from "alchemy/Auth/Resolve";
import * as Layer from "effect/Layer";
import { MUX_AUTH_PROVIDER_NAME, type MuxResolvedCredentials } from "./AuthProvider.ts";

export { Credentials, DEFAULT_API_BASE_URL } from "@distilled.cloud/mux/Credentials";

/**
 * A `Credentials` layer that resolves the Mux access token through the
 * Alchemy AuthProvider for the current profile.
 */
export const fromAuthProvider = () =>
  Layer.effect(
    Credentials,
    lazyCredentials<MuxResolvedCredentials, ConfigError>()(MUX_AUTH_PROVIDER_NAME, (creds) => ({
      auth: {
        _tag: "AccessToken" as const,
        tokenId: creds.tokenId,
        tokenSecret: creds.tokenSecret,
      },
      apiBaseUrl: creds.apiBaseUrl,
    })),
  );
