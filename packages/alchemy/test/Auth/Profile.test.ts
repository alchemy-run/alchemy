import {
  AuthError,
  AuthProviderLayer,
  AuthProviders,
  getAuthProvider,
} from "@/Auth/AuthProvider.ts";
import {
  configFilePath,
  DEFAULT_PROFILE_ID,
  PROFILE_MANIFEST_VERSION,
  ProfileError,
  ProfileStore,
  ProfileStoreLive,
  resolveProviderConfig,
  validateProfileName,
} from "@/Auth/Profile.ts";
import { resolveProfileName } from "@/Cli/ProfileSelection.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "alchemy-test";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import path from "pathe";

const FAKE_PROVIDER = "FakeAuthProvider";

// Records whether the lock-wrapped `configure` was ever entered. A missing
// profile must short-circuit before provider configuration starts.
const state = { configureCalls: 0 };

const FakeAuth = AuthProviderLayer<{ method: "stored" }, undefined>()(
  FAKE_PROVIDER,
  {
    configSchema: Schema.Struct({ method: Schema.Literal("stored") }),
    configure: () =>
      Effect.sync(() => {
        state.configureCalls += 1;
        return { method: "stored" as const };
      }),
    login: () => Effect.void,
    logout: () => Effect.void,
    details: () => Effect.succeed({ lines: [] }),
    read: () => Effect.succeed(undefined),
  },
);

const ENV_PROVIDER = "FakeEnvAuthProvider";

/** A provider that supports both profile and environment credentials. */
const FakeEnvAuth = AuthProviderLayer<{ method: "stored" }, string>()(
  ENV_PROVIDER,
  {
    configSchema: Schema.Struct({ method: Schema.Literal("stored") }),
    configure: () => Effect.succeed({ method: "stored" as const }),
    login: () => Effect.void,
    logout: () => Effect.void,
    details: () => Effect.succeed({ lines: [] }),
    read: () => Effect.succeed("profile-credentials"),
    readEnvironment: Effect.succeed("environment-credentials"),
    environment: [{ name: "FAKE_ENV_TOKEN", required: true, secret: true }],
  },
);

const makeTestLayer = (config: Record<string, unknown> = {}) =>
  Layer.mergeAll(ProfileStoreLive, FakeAuth, FakeEnvAuth).pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        Layer.succeed(AuthProviders, {}),
        ConfigProvider.layer(ConfigProvider.fromUnknown(config)),
        NodeServices.layer,
      ),
    ),
  );

/**
 * Point `ALCHEMY_HOME` at a scoped temp directory for the duration of
 * `effect`, so store operations never touch the developer's real
 * `~/.alchemy`. Tests using this must be `exclusive` — the env var is
 * process-global.
 */
const withTempHome = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
  config: Record<string, unknown> = {},
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const dir = yield* fs.makeTempDirectoryScoped({ prefix: "alchemy-auth-" });
    const previous = process.env.ALCHEMY_HOME;
    yield* Effect.acquireRelease(
      Effect.sync(() => {
        process.env.ALCHEMY_HOME = dir;
      }),
      () =>
        Effect.sync(() => {
          if (previous === undefined) delete process.env.ALCHEMY_HOME;
          else process.env.ALCHEMY_HOME = previous;
        }),
    );
    return yield* effect;
  }).pipe(Effect.scoped, Effect.provide(makeTestLayer(config)));

/** Set a process env var for the duration of the surrounding scope. */
const withProcessEnv = (name: string, value: string) =>
  Effect.acquireRelease(
    Effect.sync(() => {
      const previous = process.env[name];
      process.env[name] = value;
      return previous;
    }),
    (previous) =>
      Effect.sync(() => {
        if (previous === undefined) delete process.env[name];
        else process.env[name] = previous;
      }),
  );

it.live(
  "loadProviderConfig requires profiles to be explicitly created",
  () =>
    withTempHome(
      Effect.gen(function* () {
        state.configureCalls = 0;
        const profile = yield* ProfileStore;
        const auth = yield* getAuthProvider<{ method: "stored" }, undefined>(
          FAKE_PROVIDER,
        );

        const error = yield* profile
          .loadProviderConfig(auth, "non-existent")
          .pipe(Effect.flip);

        expect(error).toBeInstanceOf(ProfileError);
        expect((error as ProfileError).message).toContain("profile create");
        // The lock-wrapped `configure` must never run.
        expect(state.configureCalls).toBe(0);
      }),
    ),
  { exclusive: true },
);

it.live(
  "loadProviderConfig never configures a missing provider implicitly",
  () =>
    withTempHome(
      Effect.gen(function* () {
        state.configureCalls = 0;
        const profile = yield* ProfileStore;
        const auth = yield* getAuthProvider<{ method: "stored" }, undefined>(
          FAKE_PROVIDER,
        );
        yield* profile.createProfile("explicit-login");

        const error = yield* profile
          .loadProviderConfig(auth, "explicit-login")
          .pipe(Effect.flip);

        expect(error).toBeInstanceOf(AuthError);
        expect((error as AuthError).message).toContain(
          `alchemy profile edit explicit-login --add ${FAKE_PROVIDER}`,
        );
        expect(state.configureCalls).toBe(0);
      }),
    ),
  { exclusive: true },
);

it.live(
  "the default profile always exists with the stable default id",
  () =>
    withTempHome(
      Effect.gen(function* () {
        const profile = yield* ProfileStore;
        // No manifest on disk at all — the default must still be there.
        const manifest = yield* profile.readManifest;
        expect(manifest.profiles.default).toBeDefined();
        expect(manifest.profiles.default!.id).toBe(DEFAULT_PROFILE_ID);
        expect(manifest.profiles.default!.providers).toEqual({});
        // Stable across reads even before anything is persisted.
        const again = yield* profile.readManifest;
        expect(again.profiles.default!.id).toBe(DEFAULT_PROFILE_ID);
        // And ensureProfile resolves it without explicit creation.
        expect((yield* profile.ensureProfile("default")).id).toBe(
          DEFAULT_PROFILE_ID,
        );
      }),
    ),
  { exclusive: true },
);

it.live(
  "profile ids survive renames and the first write persists the default",
  () =>
    withTempHome(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const profile = yield* ProfileStore;
        yield* profile.createProfile("work");
        const created = (yield* profile.readManifest).profiles.work!;
        expect(created.id).not.toBe("");

        yield* profile.renameProfile("work", "job");
        const manifest = yield* profile.readManifest;
        expect(manifest.profiles.work).toBeUndefined();
        expect(manifest.profiles.job!.id).toBe(created.id);

        // The write that created "work" also persisted the synthesized
        // default profile with its stable id.
        const raw = JSON.parse(yield* fs.readFileString(configFilePath())) as {
          version: number;
          profiles: Record<string, { id: string }>;
        };
        expect(raw.version).toBe(PROFILE_MANIFEST_VERSION);
        expect(raw.profiles.default!.id).toBe(DEFAULT_PROFILE_ID);
      }),
    ),
  { exclusive: true },
);

it.live(
  "migrates pre-id manifests and preserves unknown top-level keys",
  () =>
    withTempHome(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const profile = yield* ProfileStore;
        yield* fs.makeDirectory(path.dirname(configFilePath()), {
          recursive: true,
        });
        yield* fs.writeFileString(
          configFilePath(),
          JSON.stringify({
            version: 0,
            futureField: { anything: true },
            profiles: {
              legacy: {
                Cloudflare: { method: "oauth", scopes: ["d1.write"] },
              },
            },
          }),
        );

        const manifest = yield* profile.readManifest;
        // Migrated in place: id defaults to the profile name so it is
        // deterministic before the manifest is rewritten.
        expect(manifest.profiles.legacy!.id).toBe("legacy");
        expect(manifest.profiles.legacy!.providers.Cloudflare).toEqual({
          method: "oauth",
          scopes: ["d1.write"],
        });
        expect(manifest.profiles.default).toBeDefined();

        // A write upgrades the version but keeps unknown top-level keys.
        yield* profile.setDefaultProfile("legacy");
        const raw = JSON.parse(
          yield* fs.readFileString(configFilePath()),
        ) as Record<string, unknown>;
        expect(raw.version).toBe(PROFILE_MANIFEST_VERSION);
        expect(raw.futureField).toEqual({ anything: true });
      }),
    ),
  { exclusive: true },
);

it.live(
  "legacy env-method entries are dropped on read",
  () =>
    withTempHome(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const profile = yield* ProfileStore;
        const auth = yield* getAuthProvider<{ method: "stored" }, undefined>(
          FAKE_PROVIDER,
        );
        yield* fs.makeDirectory(path.dirname(configFilePath()), {
          recursive: true,
        });
        yield* fs.writeFileString(
          configFilePath(),
          JSON.stringify({
            version: 0,
            profiles: {
              ci: {
                [FAKE_PROVIDER]: { method: "env" },
                Other: { method: "stored" },
              },
            },
          }),
        );

        // The env-backed entry never surfaces: not in the read manifest...
        const manifest = yield* profile.readManifest;
        expect(manifest.profiles.ci!.providers[FAKE_PROVIDER]).toBeUndefined();
        expect(manifest.profiles.ci!.providers.Other).toEqual({
          method: "stored",
        });

        // ...and credential resolution reports "not configured" with the
        // hint to connect the provider, not a legacy-env special case.
        const error = yield* profile
          .loadProviderConfig(auth, "ci")
          .pipe(Effect.flip);
        expect(error).toBeInstanceOf(AuthError);
        expect((error as AuthError).message).toContain("--add");

        // A manifest write persists the removal.
        yield* profile.setDefaultProfile("ci");
        const raw = JSON.parse(yield* fs.readFileString(configFilePath())) as {
          profiles: Record<string, { providers: Record<string, unknown> }>;
        };
        expect(raw.profiles.ci!.providers[FAKE_PROVIDER]).toBeUndefined();
        expect(raw.profiles.ci!.providers.Other).toBeDefined();
      }),
    ),
  { exclusive: true },
);

it.effect("accepts portable profile names", () =>
  Effect.gen(function* () {
    expect(yield* validateProfileName("production-admin")).toBe(
      "production-admin",
    );
    expect(yield* validateProfileName("team.prod_2")).toBe("team.prod_2");
  }),
);

it.effect(
  "rejects profile names that can escape the credential directory",
  () =>
    Effect.gen(function* () {
      for (const name of ["..", "../..", "team/prod", "/tmp/profile", ""]) {
        const error = yield* validateProfileName(name).pipe(Effect.flip);
        expect(error).toBeInstanceOf(ProfileError);
      }
    }),
);

it.effect("resolves the profile from env files and --profile overrides", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const file = yield* fs.makeTempFileScoped();
    yield* fs.writeFileString(file, "ALCHEMY_PROFILE=from-env-file\n");

    expect(yield* resolveProfileName(Option.some(file), undefined)).toBe(
      "from-env-file",
    );
    expect(yield* resolveProfileName(Option.some(file), "from-cli")).toBe(
      "from-cli",
    );
  }).pipe(Effect.scoped, Effect.provide(makeTestLayer())),
);

it.live(
  "explicitly exported provider variables win over the implicit profile",
  () =>
    withTempHome(
      Effect.gen(function* () {
        yield* withProcessEnv("FAKE_ENV_TOKEN", "from-env");
        const resolved = yield* resolveProviderConfig(ENV_PROVIDER);
        expect(resolved.source).toBe("environment");
        expect(yield* resolved.resolve).toBe("environment-credentials");
      }),
    ),
  { exclusive: true },
);

it.live(
  "an explicit profile selection ignores provider environment variables",
  () =>
    withTempHome(
      Effect.gen(function* () {
        yield* withProcessEnv("FAKE_ENV_TOKEN", "from-env");
        // ALCHEMY_PROFILE (the --profile mechanism) selects the profile
        // explicitly, so the exported variable must NOT short-circuit —
        // the unconfigured provider fails with the connect hint instead.
        const error = yield* resolveProviderConfig(ENV_PROVIDER).pipe(
          Effect.flip,
        );
        expect(error).toBeInstanceOf(AuthError);
        expect((error as AuthError).message).toContain("--add");
      }),
      { ALCHEMY_PROFILE: "default" },
    ),
  { exclusive: true },
);

it.live(
  "CI resolves environment credentials without touching profiles",
  () =>
    withTempHome(
      Effect.gen(function* () {
        // No process.env presence required: CI reads through the config
        // provider (env + --env-file) and never consults the profile.
        const resolved = yield* resolveProviderConfig(ENV_PROVIDER);
        expect(resolved.source).toBe("environment");
        expect(resolved.profileName).toBeUndefined();
      }),
      { CI: true, ALCHEMY_PROFILE: "default" },
    ),
  { exclusive: true },
);

it.live(
  "an invalid stored provider entry fails with a reconfigure hint",
  () =>
    withTempHome(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const profile = yield* ProfileStore;
        const auth = yield* getAuthProvider<{ method: "stored" }, undefined>(
          FAKE_PROVIDER,
        );
        yield* fs.makeDirectory(path.dirname(configFilePath()), {
          recursive: true,
        });
        yield* fs.writeFileString(
          configFilePath(),
          JSON.stringify({
            version: 0,
            profiles: { ci: { [FAKE_PROVIDER]: { method: "bogus" } } },
          }),
        );

        const error = yield* profile
          .loadProviderConfig(auth, "ci")
          .pipe(Effect.flip);
        expect(error).toBeInstanceOf(AuthError);
        expect((error as AuthError).message).toContain("--reconfigure");
        expect((error as AuthError).message).toContain("bogus");
      }),
    ),
  { exclusive: true },
);
