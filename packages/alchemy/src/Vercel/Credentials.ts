import { ConfigError } from "@distilled.cloud/core/errors";
import {
  Credentials,
  DEFAULT_API_BASE_URL,
} from "@distilled.cloud/vercel/Credentials";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { getAuthProvider } from "../Auth/AuthProvider.ts";
import { getEnv } from "../Auth/Env.ts";
import { ALCHEMY_PROFILE, AlchemyProfile } from "../Auth/Profile.ts";
import {
  VERCEL_AUTH_PROVIDER_NAME,
  type VercelAuthConfig,
  type VercelResolvedCredentials,
} from "./AuthProvider.ts";

export { Credentials } from "@distilled.cloud/vercel/Credentials";

export const fromAuthProvider = () =>
  Layer.effect(
    Credentials,
    Effect.gen(function* () {
      const profile = yield* AlchemyProfile;
      const auth = yield* getAuthProvider<
        VercelAuthConfig,
        VercelResolvedCredentials
      >(VERCEL_AUTH_PROVIDER_NAME);
      const profileName = yield* ALCHEMY_PROFILE;
      const ci = yield* Config.boolean("CI").pipe(Config.withDefault(false));
      const apiBaseUrl =
        (yield* getEnv("VERCEL_API_URL")) ?? DEFAULT_API_BASE_URL;

      return yield* profile.loadOrConfigure(auth, profileName, { ci }).pipe(
        Effect.flatMap((config) =>
          auth.read(profileName, config as VercelAuthConfig),
        ),
        Effect.map((creds) => ({
          token: creds.apiToken,
          apiBaseUrl,
        })),
        Effect.mapError(
          (e) =>
            new ConfigError({
              message: `Failed to resolve Vercel credentials for profile '${profileName}': ${(e as { message?: string }).message ?? String(e)}`,
            }),
        ),
        Effect.orDie,
        Effect.cached,
      );
    }),
  );
