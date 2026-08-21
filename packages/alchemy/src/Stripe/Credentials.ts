import { ConfigError } from "@distilled.cloud/core/errors";
import {
  Credentials,
  credentials as stripeCredentials,
} from "@distilled.cloud/stripe";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import { getAuthProvider } from "../Auth/AuthProvider.ts";
import { ALCHEMY_PROFILE, AlchemyProfile } from "../Auth/Profile.ts";
import {
  STRIPE_AUTH_PROVIDER_NAME,
  type StripeAuthConfig,
  type StripeResolvedCredentials,
} from "./AuthProvider.ts";

export {
  Credentials,
  CredentialsFromEnv,
  credentials,
  DEFAULT_API_BASE_URL,
  type Config as CredentialsConfig,
} from "@distilled.cloud/stripe";

/**
 * Build a Stripe `Credentials` layer that resolves credentials via the
 * Alchemy AuthProvider using the configured profile (defaults to "default",
 * overridable with the `ALCHEMY_PROFILE` env/config value).
 *
 * Maps onto `@distilled.cloud/stripe`'s `{ apiKey, apiBaseUrl }` shape.
 * Distilled's `Credentials` service is an `Effect<Config>` (resolved per
 * request) whose `apiKey` must be a Redacted from distilled's `effect`
 * instance — `credentials()` re-wraps the unredacted key.
 */
export const fromAuthProvider = () =>
  Layer.unwrap(
    Effect.gen(function* () {
      const profile = yield* AlchemyProfile;
      const auth = yield* getAuthProvider<
        StripeAuthConfig,
        StripeResolvedCredentials
      >(STRIPE_AUTH_PROVIDER_NAME);
      const profileName = yield* ALCHEMY_PROFILE;
      const ci = yield* Config.boolean("CI").pipe(Config.withDefault(false));

      const creds = yield* profile
        .loadOrConfigure(auth, profileName, { ci })
        .pipe(
          Effect.flatMap((config) =>
            auth.read(profileName, config as StripeAuthConfig),
          ),
          Effect.mapError(
            (e) =>
              new ConfigError({
                message: `Failed to resolve Stripe credentials for profile '${profileName}': ${(e as { message?: string }).message ?? String(e)}`,
              }),
          ),
          Effect.orDie,
        );

      return stripeCredentials({
        apiKey: Redacted.value(creds.apiKey),
        apiBaseUrl: creds.apiBaseUrl,
      });
    }),
  );
