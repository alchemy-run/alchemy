import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import { getAuthProvider } from "../Auth/AuthProvider.ts";
import { ALCHEMY_PROFILE, AlchemyProfile } from "../Auth/Profile.ts";
import {
  CLOUDFLARE_AUTH_PROVIDER_NAME,
  type CloudflareAuthConfig,
  type CloudflareResolvedCredentials,
} from "./Auth/AuthProvider.ts";

export class CloudflareEnvironment extends Context.Service<
  CloudflareEnvironment,
  Effect.Effect<CloudflareResolvedCredentials>
>()("Cloudflare::CloudflareEnvironment") {
  readonly kind = "Environment" as const;
}

const CLOUDFLARE_ACCOUNT_ID = Config.string("CLOUDFLARE_ACCOUNT_ID");

export const fromEnv = () =>
  Layer.effect(
    CloudflareEnvironment,
    Effect.gen(function* () {
      const accountId = yield* CLOUDFLARE_ACCOUNT_ID.pipe(
        Config.option,
        Config.map(Option.getOrUndefined),
      );
      return { account: accountId } as any;
    }),
  );

/**
 * A fixed environment for an explicit account + API token, bypassing the
 * Alchemy profile entirely.
 *
 * Used to point part of a stack at a different Cloudflare account than the
 * one it deploys into — most commonly a dedicated state-store account via
 * `Cloudflare.state({ accountId, apiToken })`. Pair it with a matching
 * `Credentials` layer (`Credentials.fromApiToken`): the account and the
 * token that can authenticate against it always travel together.
 */
export const ofApiToken = (options: {
  readonly accountId: string;
  readonly apiToken: string | Redacted.Redacted<string>;
}) =>
  Layer.succeed(
    CloudflareEnvironment,
    Effect.succeed<CloudflareResolvedCredentials>({
      type: "apiToken",
      apiToken: Redacted.isRedacted(options.apiToken)
        ? options.apiToken
        : Redacted.make(options.apiToken),
      accountId: options.accountId,
      source: { type: "env", details: "explicit apiToken" },
    }),
  );

export const fromProfile = () =>
  Layer.effect(
    CloudflareEnvironment,
    Effect.gen(function* () {
      const profile = yield* AlchemyProfile;
      const auth = yield* getAuthProvider<
        CloudflareAuthConfig,
        CloudflareResolvedCredentials
      >(CLOUDFLARE_AUTH_PROVIDER_NAME);
      const profileName = yield* ALCHEMY_PROFILE;
      const ci = yield* Config.boolean("CI").pipe(Config.withDefault(false));
      // `loadOrConfigure` reads the persisted config under the canonical
      // provider name (`Cloudflare`); only runs `configure` (and persists the
      // result) if no stored config exists.
      return yield* profile.loadOrConfigure(auth, profileName, { ci }).pipe(
        Effect.flatMap((config) =>
          auth.read(profileName, config as CloudflareAuthConfig),
        ),
        Effect.orDie,
        Effect.cached,
      );
    }),
  );
