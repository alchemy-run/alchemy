import { ConfigError } from "@distilled.cloud/core/errors";
import { Credentials, DEFAULT_API_BASE_URL } from "@distilled.cloud/stripe";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { getAuthProvider } from "../Auth/AuthProvider.ts";
import { ALCHEMY_PROFILE, AlchemyProfile } from "../Auth/Profile.ts";
import {
  STRIPE_AUTH_PROVIDER_NAME,
  type StripeAuthConfig,
  type StripeResolvedCredentials,
} from "./AuthProvider.ts";

export { Credentials } from "@distilled.cloud/stripe";

export const fromAuthProvider = () =>
  Layer.effect(
    Credentials,
    Effect.gen(function* () {
      const profile = yield* AlchemyProfile;
      const auth = yield* getAuthProvider<
        StripeAuthConfig,
        StripeResolvedCredentials
      >(STRIPE_AUTH_PROVIDER_NAME);
      const profileName = yield* ALCHEMY_PROFILE;
      const ci = yield* Config.boolean("CI").pipe(Config.withDefault(false));

      return yield* profile.loadOrConfigure(auth, profileName, { ci }).pipe(
        Effect.flatMap((config) =>
          auth.read(profileName, config as StripeAuthConfig),
        ),
        Effect.map((creds) => ({
          apiKey: creds.apiKey,
          apiBaseUrl: DEFAULT_API_BASE_URL,
        })),
        Effect.mapError(
          (e) =>
            new ConfigError({
              message: `Failed to resolve Stripe credentials for profile '${profileName}': ${(e as { message?: string }).message ?? String(e)}`,
            }),
        ),
        Effect.orDie,
        Effect.cached,
      );
    }),
  );
