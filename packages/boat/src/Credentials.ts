import { Credentials } from "@distilled.cloud/boat-dev/Credentials";
import { lazyCredentials } from "alchemy/Auth/Resolve";
import * as Effect from "effect/Effect";
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
 * `BOAT_API_KEY` (+ `BOAT_ORG`) when set, otherwise the selected profile,
 * whose `org` every call sends as `X-Boat-Org`; `options.org` overrides
 * it. Resolution is
 * deferred until the first API call, so building the provider layers never
 * needs a profile.
 */
export const fromAuthProvider = (options?: { readonly org?: string }) =>
  Layer.effect(
    Credentials,
    // `Credentials` has no error channel: a failed resolution dies, and the
    // engine reports it as `CredentialsRequired`.
    lazyCredentials<BoatResolvedCredentials>()(BOAT_AUTH_PROVIDER_NAME, (creds) => {
      const org = options?.org ?? creds.org;
      return {
        apiKey: creds.apiKey,
        apiBaseUrl: creds.apiBaseUrl,
        ...(org ? { org } : {}),
      };
    }).pipe(Effect.map(Effect.orDie)),
  );
