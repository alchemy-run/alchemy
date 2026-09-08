import { AlchemyContext } from "@/AlchemyContext.ts";
import { resolveStateStoreScope } from "@/Alchemist/routes/cloudflare.ts";
import { AuthError } from "@/Auth/AuthProvider.ts";
import { CredentialsStoreLive } from "@/Auth/Credentials.ts";
import { ProfileStore, ProfileStoreLive } from "@/Auth/Profile.ts";
import * as Interaction from "@/Interaction.ts";
import { PlatformServices } from "@/Util/PlatformServices.ts";
import { expect, it } from "alchemy-test";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";

const STAGING_ACCOUNT = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const DEFAULT_ACCOUNT = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

const CLOUDFLARE_ENV_KEYS = [
  "CI",
  "ALCHEMY_PROFILE",
  "CLOUDFLARE_ACCOUNT_ID",
  "CLOUDFLARE_API_TOKEN",
  "CLOUDFLARE_API_KEY",
  "CLOUDFLARE_EMAIL",
  "CLOUDFLARE_ACCOUNT_EMAIL",
] as const;

/**
 * Isolate `ALCHEMY_HOME` and strip env credentials / `CI` so
 * `resolveProviderConfig` actually reads the profile store. The alchemy-test
 * runner sets `CI=true` and `--profile testing` exports `ALCHEMY_PROFILE`,
 * both of which would otherwise skip the named-profile path under test.
 */
const withIsolatedHome = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const dir = yield* fs.makeTempDirectoryScoped({
      prefix: "alchemy-cf-bootstrap-profile-",
    });
    const previous: Record<string, string | undefined> = {
      ALCHEMY_HOME: process.env.ALCHEMY_HOME,
    };
    for (const key of CLOUDFLARE_ENV_KEYS) {
      previous[key] = process.env[key];
    }
    yield* Effect.acquireRelease(
      Effect.sync(() => {
        process.env.ALCHEMY_HOME = dir;
        for (const key of CLOUDFLARE_ENV_KEYS) {
          delete process.env[key];
        }
      }),
      () =>
        Effect.sync(() => {
          for (const [key, value] of Object.entries(previous)) {
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
          }
        }),
    );
    return yield* effect.pipe(
      Effect.provide(
        Layer.mergeAll(
          Layer.provide(ProfileStoreLive, PlatformServices),
          Layer.provide(CredentialsStoreLive, PlatformServices),
          Layer.succeed(AlchemyContext, {
            dotAlchemy: dir,
            dev: false,
            adopt: false,
          }),
          Interaction.layerNonInteractive(),
          ConfigProvider.layer(ConfigProvider.fromUnknown({})),
        ),
      ),
    );
  }).pipe(Effect.scoped, Effect.provide(PlatformServices));

const storedToken = (accountId: string, apiToken: string) => ({
  method: "stored" as const,
  credentialType: "apiToken" as const,
  apiToken,
  accountId,
});

it.live(
  "cloudflare bootstrap --profile resolves that profile's credentials, not default (#252)",
  () =>
    withIsolatedHome(
      Effect.gen(function* () {
        const profiles = yield* ProfileStore;
        yield* profiles.createProfile("staging");
        yield* profiles.setProviderConfig(
          "staging",
          "Cloudflare",
          storedToken(STAGING_ACCOUNT, "staging-token"),
        );
        yield* profiles.setProviderConfig(
          "default",
          "Cloudflare",
          storedToken(DEFAULT_ACCOUNT, "default-token"),
        );

        const scoped = yield* resolveStateStoreScope({ profile: "staging" });
        expect(scoped.profile).toBe("staging");
        expect(scoped.accountId).toBe(STAGING_ACCOUNT);
      }),
    ),
  { exclusive: true },
);

it.live(
  "cloudflare bootstrap without --profile uses the default profile",
  () =>
    withIsolatedHome(
      Effect.gen(function* () {
        const profiles = yield* ProfileStore;
        yield* profiles.setProviderConfig(
          "default",
          "Cloudflare",
          storedToken(DEFAULT_ACCOUNT, "default-token"),
        );

        const scoped = yield* resolveStateStoreScope({});
        expect(scoped.profile).toBe("default");
        expect(scoped.accountId).toBe(DEFAULT_ACCOUNT);
      }),
    ),
  { exclusive: true },
);

it.live(
  "cloudflare bootstrap --profile does not fall back to an unconfigured default",
  () =>
    withIsolatedHome(
      Effect.gen(function* () {
        const profiles = yield* ProfileStore;
        yield* profiles.createProfile("staging");
        yield* profiles.setProviderConfig(
          "staging",
          "Cloudflare",
          storedToken(STAGING_ACCOUNT, "staging-token"),
        );

        const scoped = yield* resolveStateStoreScope({ profile: "staging" });
        expect(scoped.accountId).toBe(STAGING_ACCOUNT);

        const missing = yield* resolveStateStoreScope({}).pipe(Effect.flip);
        expect(missing).toBeInstanceOf(AuthError);
        expect((missing as AuthError).message).toContain("profile 'default'");
      }),
    ),
  { exclusive: true },
);
