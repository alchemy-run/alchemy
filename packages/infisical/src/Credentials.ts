import { Credentials } from "@distilled.cloud/infisical/Credentials";
import { lazyCredentials } from "alchemy/Auth/Resolve";
import * as Effect from "effect/Effect";
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
    // `Credentials` has no error channel: a failed resolution dies, and the
    // engine reports it as `CredentialsRequired`.
    lazyCredentials<InfisicalResolvedCredentials>()(
      INFISICAL_AUTH_PROVIDER_NAME,
      ({ token, apiBaseUrl }) => ({ apiKey: token, apiBaseUrl }),
      // Cache a minted access token only until it expires.
      { expiresAt: ({ expires }) => expires },
    ).pipe(Effect.map(Effect.orDie)),
  );
