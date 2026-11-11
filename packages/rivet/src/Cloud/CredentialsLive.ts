import { lazyCredentials } from "alchemy/Auth/Resolve";
import * as Layer from "effect/Layer";
import { RIVET_CLOUD_AUTH_PROVIDER_NAME, type RivetCloudCredentials } from "./AuthProvider.ts";
import { Credentials } from "./Credentials.ts";

/**
 * {@link Credentials} from the alchemy profile, or from the environment in
 * CI. Resolution waits for the first deploy that asks, and a sign-in
 * session is re-resolved, and so refreshed, shortly before it expires.
 */
export const CredentialsLive = Layer.effect(
  Credentials,
  lazyCredentials<RivetCloudCredentials>()(
    RIVET_CLOUD_AUTH_PROVIDER_NAME,
    (credentials) => credentials,
    { expiresAt: (credentials) => credentials.expires },
  ),
);
