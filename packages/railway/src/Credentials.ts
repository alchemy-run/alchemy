import { Credentials, toConfig } from "@distilled.cloud/railway";
import { lazyCredentials } from "alchemy/Auth/Resolve";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { RAILWAY_AUTH_PROVIDER_NAME, type RailwayResolvedCredentials } from "./AuthProvider.ts";

export {
  Credentials,
  CredentialsFromEnv,
  CredentialsFromToken,
  DEFAULT_API_BASE_URL,
  type Config as CredentialsConfig,
  type TokenKind,
} from "@distilled.cloud/railway";

/**
 * Build a `Credentials` layer that resolves Railway credentials via the
 * current Alchemy profile, or directly from environment variables in CI.
 *
 * Maps onto `@distilled.cloud/railway`'s
 * `{ token, tokenKind: "account", apiBaseUrl }` shape. Alchemy itself only
 * reads `RAILWAY_API_TOKEN` (account Bearer). Distilled's own
 * `CredentialsFromEnv` also accepts `RAILWAY_TOKEN` / `RAILWAY_PROJECT_TOKEN`
 * as fallbacks.
 */
export const fromAuthProvider = () =>
  Layer.effect(
    Credentials,
    // `Credentials` has no error channel: a failed resolution dies, and the
    // engine reports it as `CredentialsRequired`.
    lazyCredentials<RailwayResolvedCredentials>()(RAILWAY_AUTH_PROVIDER_NAME, (creds) =>
      toConfig({
        token: creds.token,
        tokenKind: creds.tokenKind,
        apiBaseUrl: creds.apiBaseUrl,
      }),
    ).pipe(Effect.map(Effect.orDie)),
  );
