import { Credentials } from "@distilled.cloud/neon/Credentials";
import { ConfigError } from "@distilled.cloud/core/errors";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { getAuthProvider } from "../Auth/AuthProvider.ts";
import { ALCHEMY_PROFILE, loadOrConfigure } from "../Auth/Profile.ts";
import {
  NEON_AUTH_PROVIDER_NAME,
  type NeonAuthConfig,
  type NeonResolvedCredentials,
} from "./AuthProvider.ts";

export { Credentials } from "@distilled.cloud/neon/Credentials";

const DEFAULT_BASE_URL = "https://console.neon.tech/api/v2";

export const fromAuthProvider = () =>
  Layer.effect(
    Credentials,
    Effect.gen(function* () {
      const auth = yield* getAuthProvider<
        NeonAuthConfig,
        NeonResolvedCredentials
      >(NEON_AUTH_PROVIDER_NAME);
      const profileName = yield* ALCHEMY_PROFILE;
      const ci = yield* Config.boolean("CI").pipe(Config.withDefault(false));
      const ctx = yield* Effect.context<never>();

      return yield* loadOrConfigure(auth, profileName, { ci }).pipe(
        Effect.flatMap((config) =>
          auth.read(profileName, config as NeonAuthConfig),
        ),
        Effect.map((creds) => ({
          apiKey: creds.apiKey,
          apiBaseUrl: DEFAULT_BASE_URL,
        })),
        Effect.mapError(
          (e) =>
            new ConfigError({
              message: `Failed to resolve Neon credentials for profile '${profileName}': ${(e as { message?: string }).message ?? String(e)}`,
            }),
        ),
        Effect.provide(ctx),
      );
    }),
  );
