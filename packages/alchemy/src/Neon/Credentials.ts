import { ConfigError } from "@distilled.cloud/core/errors";
import { Credentials } from "@distilled.cloud/neon";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { resolveProviderConfig } from "../Auth/Profile.ts";
import {
  NEON_AUTH_PROVIDER_NAME,
  type NeonAuthConfig,
  type NeonResolvedCredentials,
} from "./AuthProvider.ts";

export { Credentials } from "@distilled.cloud/neon";

const DEFAULT_BASE_URL = "https://console.neon.tech/api/v2";

export const fromAuthProvider = () =>
  Layer.effect(
    Credentials,
    Effect.gen(function* () {
      const { auth, profileName, config } = yield* resolveProviderConfig<
        NeonAuthConfig,
        NeonResolvedCredentials
      >(NEON_AUTH_PROVIDER_NAME);

      return yield* auth.read(profileName, config).pipe(
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
        Effect.orDie,
        Effect.cached,
      );
    }),
  );
