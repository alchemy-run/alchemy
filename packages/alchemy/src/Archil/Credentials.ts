import { ConfigError } from "@distilled.cloud/core/errors";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import { getAuthProvider } from "../Auth/AuthProvider.ts";
import { ALCHEMY_PROFILE, AlchemyProfile } from "../Auth/Profile.ts";
import {
  ARCHIL_AUTH_PROVIDER_NAME,
  type ArchilAuthConfig,
  type ArchilResolvedCredentials,
} from "./AuthProvider.ts";
import { DEFAULT_REGION, type ArchilRegion } from "./Region.ts";

/**
 * Resolved Archil credentials: the control-plane API key plus the region
 * used when a resource doesn't specify one.
 */
export interface CredentialsConfig {
  readonly apiKey: Redacted.Redacted<string>;
  /**
   * Region used when a resource/capability does not specify one.
   * @default "aws-us-east-1" (override with `ARCHIL_REGION`)
   */
  readonly defaultRegion: ArchilRegion;
}

/**
 * Context service holding the resolved Archil credentials. The service value
 * is an Effect so resolution can be lazy + cached (mirrors the distilled
 * credentials services).
 */
export class Credentials extends Context.Service<
  Credentials,
  Effect.Effect<CredentialsConfig>
>()("ArchilCredentials") {}

const regionFromEnv = Config.string("ARCHIL_REGION").pipe(
  Config.withDefault(DEFAULT_REGION),
  Config.map((r) => r as ArchilRegion),
);

/**
 * Resolve credentials through the Alchemy profile system (env `ARCHIL_API_KEY`
 * or an interactively-stored key in `~/.alchemy/credentials`).
 */
export const fromAuthProvider = () =>
  Layer.effect(
    Credentials,
    Effect.gen(function* () {
      const profile = yield* AlchemyProfile;
      const auth = yield* getAuthProvider<
        ArchilAuthConfig,
        ArchilResolvedCredentials
      >(ARCHIL_AUTH_PROVIDER_NAME);
      const profileName = yield* ALCHEMY_PROFILE;
      const ci = yield* Config.boolean("CI").pipe(Config.withDefault(false));
      const defaultRegion = yield* regionFromEnv;

      return yield* profile.loadOrConfigure(auth, profileName, { ci }).pipe(
        Effect.flatMap((config) =>
          auth.read(profileName, config as ArchilAuthConfig),
        ),
        Effect.map((creds) => ({
          apiKey: creds.apiKey,
          defaultRegion,
        })),
        Effect.mapError(
          (e) =>
            new ConfigError({
              message: `Failed to resolve Archil credentials for profile '${profileName}': ${(e as { message?: string }).message ?? String(e)}`,
            }),
        ),
        Effect.orDie,
        Effect.cached,
      );
    }),
  );

/**
 * Provide credentials directly from an API key — useful in tests or when the
 * key is sourced outside the profile system.
 */
export const fromApiKey = (options: {
  apiKey: string | Redacted.Redacted<string>;
  defaultRegion?: ArchilRegion;
}) =>
  Layer.succeed(
    Credentials,
    Effect.succeed({
      apiKey:
        typeof options.apiKey === "string"
          ? Redacted.make(options.apiKey)
          : options.apiKey,
      defaultRegion: options.defaultRegion ?? DEFAULT_REGION,
    }),
  );
