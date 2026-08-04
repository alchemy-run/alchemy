import * as Cause from "effect/Cause";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
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
 * Non-forcing accountId probe against a specific {@link CloudflareEnvironment}
 * resolution effect.
 *
 * Resolves the current account id ONLY when doing so cannot prompt the user:
 * credential resolution is attempted only if the Cloudflare auth provider
 * already has stored config for the active profile (so `loadOrConfigure`
 * would return it without running the interactive `configure` flow). When no
 * config is stored — or resolution fails/dies anyway (broken stored
 * credentials, an expired token, a test override that dies on force) — the
 * probe returns `undefined` instead of failing.
 *
 * Used by the LOCAL (dev) providers to stamp `accountId` on local attributes
 * opportunistically: an all-local `alchemy dev` run must work with zero
 * configured credentials, so local lifecycle code must never *demand*
 * credential resolution. See {@link currentAccountId} for the ambient
 * variant.
 */
export const probeAccountId = (
  env: Effect.Effect<CloudflareResolvedCredentials>,
): Effect.Effect<string | undefined> =>
  Effect.gen(function* () {
    // Safety gate: forcing the environment effect may drive an interactive
    // configure flow (browser OAuth, clack prompts) when nothing is stored
    // for the active profile. Only force once stored config proves the
    // resolution is non-interactive. If the profile service isn't in
    // context we can't prove safety, so don't force.
    const profile = yield* Effect.serviceOption(AlchemyProfile);
    if (Option.isNone(profile)) return undefined;
    const profileName = yield* ALCHEMY_PROFILE.pipe(
      Effect.orElseSucceed(() => "default"),
    );
    const providers = yield* profile.value.getProfile(profileName);
    if (providers?.[CLOUDFLARE_AUTH_PROVIDER_NAME] === undefined) {
      return undefined;
    }
    // Stored config exists — resolution is non-interactive (`auth.read`
    // never prompts). It can still fail or die (env vars missing, expired
    // refresh token, a test layer that dies on force): a probe is best
    // effort, so swallow everything except interruption.
    return yield* env.pipe(
      Effect.map((credentials): string | undefined => credentials.accountId),
      Effect.catchCause(
        (cause): Effect.Effect<string | undefined> =>
          Cause.hasInterrupts(cause)
            ? Effect.failCause(cause)
            : Effect.succeed(undefined),
      ),
    );
  });

/**
 * Ambient variant of {@link probeAccountId}: probes the
 * {@link CloudflareEnvironment} available in the current context, returning
 * `undefined` when the service isn't provided at all.
 *
 * This is the primitive LOCAL providers use in `diff`/`reconcile` to stamp
 * `accountId: string | undefined` without ever demanding credentials.
 */
export const currentAccountId: Effect.Effect<string | undefined> =
  Effect.serviceOption(CloudflareEnvironment).pipe(
    Effect.flatMap(
      Option.match({
        onNone: () => Effect.succeed(undefined),
        onSome: (env) => probeAccountId(env),
      }),
    ),
  );

/**
 * Local-mode account-drift rule for provider `diff`s: a local resource is
 * replaced on an account switch ONLY when both the stamped and the currently
 * probed account id are known and differ. `undefined` on either side matches
 * anything — otherwise the first run after `alchemy login` would replace
 * every credential-free local resource and wipe its data.
 */
export const isAccountDrift = (
  stamped: string | undefined,
  current: string | undefined,
): boolean =>
  stamped !== undefined && current !== undefined && stamped !== current;

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
