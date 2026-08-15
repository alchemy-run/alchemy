import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { getAuthProvider } from "../Auth/AuthProvider.ts";
import { ALCHEMY_PROFILE, AlchemyProfile } from "../Auth/Profile.ts";
import {
  VERCEL_AUTH_PROVIDER_NAME,
  type VercelAuthConfig,
  type VercelResolvedCredentials,
} from "./AuthProvider.ts";

/**
 * Tenancy for a Vercel stack (≙ Cloudflare's `accountId`). Vercel scopes
 * team requests via a per-op `teamId` query parameter, so providers resolve
 * it INSIDE lifecycle operations (`yield* VercelEnvironment.current`) and
 * pass it whenever set — never via per-resource props.
 */
export interface VercelEnvironmentShape {
  /** Team to operate in; `undefined` = personal scope. */
  teamId?: string;
}

export class VercelEnvironment extends Context.Service<
  VercelEnvironment,
  Effect.Effect<VercelEnvironmentShape>
>()("Vercel::VercelEnvironment") {
  static current = VercelEnvironment.use((env) => env);
  readonly kind = "Environment" as const;
}

export const fromProfile = () =>
  Layer.effect(
    VercelEnvironment,
    Effect.gen(function* () {
      const profile = yield* AlchemyProfile;
      const auth = yield* getAuthProvider<
        VercelAuthConfig,
        VercelResolvedCredentials
      >(VERCEL_AUTH_PROVIDER_NAME);
      const profileName = yield* ALCHEMY_PROFILE;
      const ci = yield* Config.boolean("CI").pipe(Config.withDefault(false));
      // `loadOrConfigure` reads the persisted config under the canonical
      // provider name (`Vercel`); only runs `configure` (and persists the
      // result) if no stored config exists.
      return yield* profile.loadOrConfigure(auth, profileName, { ci }).pipe(
        Effect.flatMap((config) =>
          auth.read(profileName, config as VercelAuthConfig),
        ),
        Effect.map((creds) => ({ teamId: creds.teamId })),
        Effect.orDie,
        Effect.cached,
      );
    }),
  );
