import { Credentials } from "@distilled.cloud/coolify/Credentials";
import { lazyCredentials } from "alchemy/Auth/Resolve";
import * as Effect from "effect/Effect";
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
    // `Credentials` has no error channel: a failed resolution dies, and the
    // engine reports it as `CredentialsRequired`.
    lazyCredentials<CoolifyResolvedCredentials>()(COOLIFY_AUTH_PROVIDER_NAME, (creds) => ({
      apiKey: creds.token,
      apiBaseUrl: creds.apiBaseUrl,
    })).pipe(Effect.map(Effect.orDie)),
  );
