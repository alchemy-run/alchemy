import { expect, it } from "alchemy-test";
import * as Cause from "effect/Cause";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import { pluginContext } from "@/Alchemist/routes/state.ts";
import { AlchemyContext } from "@/AlchemyContext.ts";
import { ArtifactStore, createArtifactStore } from "@/Artifacts.ts";
import { CredentialsStoreLive } from "@/Auth/Credentials.ts";
import { ProfileStore, ProfileStoreLive } from "@/Auth/Profile.ts";
import { CredentialsUnavailable } from "@/Auth/Resolve.ts";
import { stateStoreScope } from "@/Cloudflare/Alchemist/StateStore.ts";
import * as Interaction from "@/Interaction.ts";
import * as Plugin from "@/Plugin.ts";
import { PlatformServices } from "@/Util/PlatformServices.ts";

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
 *
 * An empty `--env-file` in the temp home is passed through so
 * `loadConfigProvider` never falls back to the checkout's cwd `.env`.
 */
const withIsolatedHome = <A, E, R>(effect: (envFile: string) => Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const dir = yield* fs.makeTempDirectoryScoped({ prefix: "alchemy-cf-bootstrap-profile-" });
    const envFile = path.join(dir, "empty.env");
    yield* fs.writeFileString(envFile, "");
    const previous: Record<string, string | undefined> = { ALCHEMY_HOME: process.env.ALCHEMY_HOME };
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
    return yield* effect(envFile).pipe(
      Effect.provide(
        Layer.mergeAll(
          Layer.provide(ProfileStoreLive, PlatformServices),
          Layer.provide(CredentialsStoreLive, PlatformServices),
          Layer.succeed(AlchemyContext, { dotAlchemy: dir, dev: false, adopt: false }),
          Interaction.layerNonInteractive(),
          ConfigProvider.layer(ConfigProvider.fromUnknown({})),
          FetchHttpClient.layer,
          Layer.succeed(ArtifactStore, createArtifactStore()),
        ),
      ),
    );
  }).pipe(Effect.scoped, Effect.provide(PlatformServices));

/**
 * The Cloudflare store's scope as `alchemy state … --backend cloudflare`
 * resolves it: under the context core builds from `--profile` and
 * `--env-file`, with the plugin's auth registered.
 */
const resolveStateStoreScope = (target: { readonly profile?: string; readonly envFile: string }) =>
  Effect.gen(function* () {
    const cloudflare = (yield* Plugin.load()).find((plugin) => plugin.name === "cloudflare");
    if (cloudflare === undefined) return yield* Effect.die(new Error("no cloudflare plugin"));
    return yield* stateStoreScope(undefined).pipe(
      Effect.provide(yield* pluginContext(cloudflare, target)),
    );
  });

const storedToken = (accountId: string, apiToken: string) => ({
  method: "stored" as const,
  credentialType: "apiToken" as const,
  apiToken,
  accountId,
});

it.live(
  "cloudflare bootstrap --profile resolves that profile's credentials, not default (#252)",
  () =>
    withIsolatedHome((envFile) =>
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

        const scoped = yield* resolveStateStoreScope({ profile: "staging", envFile });
        expect(scoped.profile).toBe("staging");
        expect(scoped.accountId).toBe(STAGING_ACCOUNT);
      }),
    ),
  { tags: ["unit", "local"], exclusive: true },
);

it.live(
  "cloudflare bootstrap without --profile uses the default profile",
  () =>
    withIsolatedHome((envFile) =>
      Effect.gen(function* () {
        const profiles = yield* ProfileStore;
        yield* profiles.setProviderConfig(
          "default",
          "Cloudflare",
          storedToken(DEFAULT_ACCOUNT, "default-token"),
        );

        const scoped = yield* resolveStateStoreScope({ envFile });
        expect(scoped.profile).toBe("default");
        expect(scoped.accountId).toBe(DEFAULT_ACCOUNT);
      }),
    ),
  { tags: ["unit", "local"], exclusive: true },
);

it.live(
  "cloudflare bootstrap --profile does not fall back to an unconfigured default",
  () =>
    withIsolatedHome((envFile) =>
      Effect.gen(function* () {
        const profiles = yield* ProfileStore;
        yield* profiles.createProfile("staging");
        yield* profiles.setProviderConfig(
          "staging",
          "Cloudflare",
          storedToken(STAGING_ACCOUNT, "staging-token"),
        );

        const scoped = yield* resolveStateStoreScope({ profile: "staging", envFile });
        expect(scoped.accountId).toBe(STAGING_ACCOUNT);

        // Environment resolution is lazy: missing auth surfaces when the
        // account is demanded, through the environment's defect channel.
        const missing = yield* Effect.exit(resolveStateStoreScope({ envFile }));
        expect(Exit.isFailure(missing)).toBe(true);
        if (Exit.isFailure(missing)) {
          const error = Cause.squash(missing.cause);
          expect(error).toBeInstanceOf(CredentialsUnavailable);
          expect(String(error)).toContain("profile 'default'");
        }
      }),
    ),
  { tags: ["unit", "local"], exclusive: true },
);
