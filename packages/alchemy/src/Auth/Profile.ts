import * as Config from "effect/Config";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type { PlatformError } from "effect/PlatformError";
import os from "node:os";
import path from "pathe";
import { writeFileAtomic } from "../Util/AtomicFile.ts";
import { isNonInteractive } from "../Util/interactive.ts";
import { AuthError, getAuthProvider } from "./AuthProvider.ts";
import type { AuthProvider, ConfigureContext } from "./AuthProvider.ts";
import { withLock, withProfileCredentialsLock } from "./Lock.ts";

export const rootDir = path.join(os.homedir(), ".alchemy");
export const configFilePath = path.join(rootDir, "profiles.json");
export const credentialsDirPath = path.join(rootDir, "credentials");

export const profileCredentialsDirPath = (profile: string) =>
  path.join(credentialsDirPath, profile);

/**
 * Config key consulted by the various `fromAuthProvider` /
 * `fromEnvironment` layers to pick which named profile in
 * `~/.alchemy/profiles.json` to use.
 */
export const ALCHEMY_PROFILE = Config.string("ALCHEMY_PROFILE");

export const PROFILE_MANIFEST_VERSION = 1;

export interface Profile {
  [providerName: string]: {
    /**
     * The method used to login to the provider. Different providers may use different methods, but common ones are:
     * - oauth: OAuth authentication
     * - api-key: API key authentication
     * - username-password: Username and password authentication
     * - token: Token authentication
     * - certificate: Certificate authentication
     * - ssh: SSH authentication
     * - other: Other authentication methods
     */
    method: string;
  };
}

export interface ProfileManifest {
  version: typeof PROFILE_MANIFEST_VERSION;
  defaultProfile?: string;
  profiles: Record<string, Profile>;
}

export interface ProfileSelection {
  readonly name: string;
  readonly source: "configuration" | "stored-default" | "fallback";
}

const ProviderConfigSchema = Schema.StructWithRest(
  Schema.Struct({ method: Schema.String }),
  [Schema.Record(Schema.String, Schema.Unknown)],
);

const StoredManifestSchema = Schema.Struct({
  version: Schema.Number,
  defaultProfile: Schema.optional(Schema.String),
  profiles: Schema.Record(
    Schema.String,
    Schema.Record(Schema.String, ProviderConfigSchema),
  ),
});

export class ProfileError extends Schema.TaggedErrorClass<ProfileError>()(
  "ProfileError",
  {
    message: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

const emptyManifest = (): ProfileManifest => ({
  version: PROFILE_MANIFEST_VERSION,
  profiles: {},
});

const profileNotFound = (name: string) =>
  new ProfileError({
    message:
      `Profile '${name}' does not exist. ` +
      `Create it first with \`alchemy profile create ${name}\`.`,
  });

/**
 * Shared by the store's locked `deleteProfile` check and the CLI's
 * friendlier pre-confirmation check, so the user-facing copy can't drift.
 */
export const cannotDeleteDefaultProfile = (name: string) =>
  new ProfileError({
    message:
      `Cannot delete profile '${name}' because it is the default profile. ` +
      "Make another profile the default first with `alchemy profile set-default <name>`.",
  });

const PROFILE_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** The name the default selection resolves to when nothing is stored. */
export const defaultProfileName = (manifest: ProfileManifest): string =>
  manifest.defaultProfile ?? "default";

export const validateProfileName = (
  name: string,
): Effect.Effect<string, ProfileError> =>
  PROFILE_NAME_PATTERN.test(name)
    ? Effect.succeed(name)
    : Effect.fail(
        new ProfileError({
          message:
            `Invalid profile name '${name}'. Profile names must start with an ASCII letter or number, ` +
            "contain only letters, numbers, '.', '_' or '-', and be at most 64 characters.",
        }),
      );

/**
 * Service exposing on-disk profile helpers. All methods have `R = never` —
 * the {@link FileSystem.FileSystem} requirement is captured by
 * {@link ProfileStoreLive} when the layer is built, freeing call sites from
 * having to thread `FileSystem` through their own Effects.
 */
export interface ProfileStoreService {
  readonly readManifest: Effect.Effect<
    ProfileManifest,
    ProfileError | PlatformError
  >;
  readonly getProfile: (
    name: string,
  ) => Effect.Effect<Profile | undefined, ProfileError | PlatformError>;
  /**
   * Like {@link getProfile}, but the default profile is implicit: if `name`
   * is the current default selection (the stored default, or the built-in
   * `default` fallback when none is stored) and it doesn't exist yet, it is
   * created empty and tagged as the stored default — so a later rename keeps
   * tracking it. Any other missing profile fails, matching `getProfile`
   * call sites that require existence.
   */
  readonly ensureProfile: (
    name: string,
  ) => Effect.Effect<Profile, ProfileError | PlatformError>;
  readonly createProfile: (
    name: string,
  ) => Effect.Effect<void, ProfileError | PlatformError>;
  readonly renameProfile: (
    name: string,
    newName: string,
  ) => Effect.Effect<void, ProfileError | PlatformError>;
  readonly setDefaultProfile: (
    name: string,
  ) => Effect.Effect<void, ProfileError | PlatformError>;
  readonly current: Effect.Effect<
    ProfileSelection,
    ProfileError | PlatformError
  >;
  readonly setProfile: (
    name: string,
    profile: Profile,
  ) => Effect.Effect<void, ProfileError | PlatformError>;
  /**
   * Delete `name` from the manifest. Returns `false` when the profile
   * doesn't exist. Fails when `name` is the current default selection —
   * make another profile the default first.
   */
  readonly deleteProfile: (
    name: string,
  ) => Effect.Effect<boolean, ProfileError | PlatformError>;
  readonly loadOrConfigure: <Config extends { method: string }>(
    auth: AuthProvider<Config>,
    profileName: string,
    ctx: ConfigureContext,
  ) => Effect.Effect<Config, AuthError | ProfileError | PlatformError>;
}

export class ProfileStore extends Context.Service<
  ProfileStore,
  ProfileStoreService
>()("Alchemy::ProfileStore") {}

/**
 * Layer that builds the {@link ProfileStore} service. Captures the
 * {@link FileSystem.FileSystem} dependency at layer-build time, so any
 * Effect that yields {@link ProfileStore} ends up with `R = ProfileStore` (no
 * `FileSystem` leak). Provide this once at the top of your runtime
 * (alongside `PlatformServices` / `NodeContext`).
 */
export const ProfileStoreLive = Layer.effect(
  ProfileStore,
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;

    const readManifest = fs.readFileString(configFilePath).pipe(
      Effect.flatMap((data) =>
        Effect.try({
          try: () => JSON.parse(data) as unknown,
          catch: (cause) =>
            new ProfileError({
              message: `Could not parse '${configFilePath}'. The file was left untouched.`,
              cause,
            }),
        }),
      ),
      Effect.flatMap((json) =>
        Schema.decodeUnknownEffect(StoredManifestSchema)(json).pipe(
          Effect.mapError(
            (cause) =>
              new ProfileError({
                message: `Invalid profile manifest at '${configFilePath}'. The file was left untouched.`,
                cause,
              }),
          ),
        ),
      ),
      Effect.flatMap((stored) =>
        // Version-0 manifests (written by pre-profile-overhaul alchemy) are
        // read as v1 — the shape is compatible — and upgraded on the next
        // `writeManifest`, which always stamps the current version.
        stored.version === 0 || stored.version === PROFILE_MANIFEST_VERSION
          ? Effect.succeed({
              version: PROFILE_MANIFEST_VERSION,
              defaultProfile: stored.defaultProfile,
              profiles: stored.profiles,
            } as ProfileManifest)
          : Effect.fail(
              new ProfileError({
                message:
                  `Profile manifest version ${stored.version} is not supported by this Alchemy version. ` +
                  "The file was left untouched.",
              }),
            ),
      ),
      Effect.catchIf(
        (e) => e._tag === "PlatformError" && e.reason._tag === "NotFound",
        () => Effect.succeed(emptyManifest()),
      ),
    );

    const writeManifest = (config: ProfileManifest) =>
      fs
        .makeDirectory(path.dirname(configFilePath), { recursive: true })
        .pipe(
          Effect.flatMap(() =>
            writeFileAtomic(
              fs,
              configFilePath,
              JSON.stringify(config, null, 2),
              0o600,
            ),
          ),
        );

    /**
     * Run `f` against the freshly-read manifest under the cross-process
     * manifest lock — the scaffold shared by every mutating store method.
     */
    const modifyManifest = <A>(
      f: (
        manifest: ProfileManifest,
      ) => Effect.Effect<A, ProfileError | PlatformError>,
    ): Effect.Effect<A, ProfileError | PlatformError> =>
      withLock("profiles-manifest", Effect.flatMap(readManifest, f));

    const getProfile = (name: string) =>
      validateProfileName(name).pipe(
        Effect.flatMap(() => readManifest),
        Effect.map((config) => config.profiles[name]),
      );

    const ensureProfile = (
      name: string,
    ): Effect.Effect<Profile, ProfileError | PlatformError> =>
      validateProfileName(name).pipe(
        Effect.flatMap(() => readManifest),
        Effect.flatMap(
          (manifest): Effect.Effect<Profile, ProfileError | PlatformError> => {
            // Lock-free fast path: credential resolution calls this on every
            // provider layer build, and the profile almost always exists.
            const existing = manifest.profiles[name];
            if (existing !== undefined) {
              return Effect.succeed(existing);
            }
            if (name !== defaultProfileName(manifest)) {
              return Effect.fail(profileNotFound(name));
            }
            // Bootstrap the implicit default profile under the lock (re-check
            // after acquiring it), tagging it as the stored default so renames
            // keep tracking it.
            return modifyManifest((manifest) => {
              const existing = manifest.profiles[name];
              if (existing !== undefined) {
                return Effect.succeed(existing);
              }
              const profile: Profile = {};
              return writeManifest({
                ...manifest,
                defaultProfile: name,
                profiles: { ...manifest.profiles, [name]: profile },
              }).pipe(Effect.as(profile));
            });
          },
        ),
      );

    const createProfile = (
      name: string,
    ): Effect.Effect<void, ProfileError | PlatformError> =>
      validateProfileName(name).pipe(
        Effect.flatMap(() =>
          modifyManifest(
            (manifest): Effect.Effect<void, ProfileError | PlatformError> =>
              name in manifest.profiles
                ? Effect.fail(
                    new ProfileError({
                      message: `Profile '${name}' already exists.`,
                    }),
                  )
                : writeManifest({
                    ...manifest,
                    profiles: { ...manifest.profiles, [name]: {} },
                  }),
          ),
        ),
      );

    const renameProfile = (
      name: string,
      newName: string,
    ): Effect.Effect<void, ProfileError | PlatformError> =>
      validateProfileName(name).pipe(
        Effect.flatMap(() => validateProfileName(newName)),
        Effect.flatMap(() => {
          const locked = modifyManifest((manifest) => {
            if (!(name in manifest.profiles)) {
              return Effect.fail(
                new ProfileError({
                  message: `Profile '${name}' does not exist.`,
                }),
              );
            }
            if (newName in manifest.profiles) {
              return Effect.fail(
                new ProfileError({
                  message: `Profile '${newName}' already exists.`,
                }),
              );
            }

            const sourceCredentials = profileCredentialsDirPath(name);
            const targetCredentials = profileCredentialsDirPath(newName);
            return Effect.all([
              fs.exists(sourceCredentials),
              fs.exists(targetCredentials),
            ]).pipe(
              Effect.flatMap(
                ([sourceExists, targetExists]): Effect.Effect<
                  void,
                  ProfileError | PlatformError
                > => {
                  if (targetExists) {
                    return Effect.fail(
                      new ProfileError({
                        message:
                          `Cannot rename profile '${name}' to '${newName}' because ` +
                          `credentials already exist at '${targetCredentials}'.`,
                      }),
                    );
                  }

                  const { [name]: renamed, ...remaining } = manifest.profiles;
                  const updated: ProfileManifest = {
                    ...manifest,
                    // Renaming the default selection re-points the tag —
                    // including the implicit `default` on manifests that
                    // never stored one — so the renamed profile is still
                    // treated as the default.
                    defaultProfile:
                      defaultProfileName(manifest) === name
                        ? newName
                        : manifest.defaultProfile,
                    profiles: { ...remaining, [newName]: renamed! },
                  };
                  const moveCredentials = sourceExists
                    ? fs.rename(sourceCredentials, targetCredentials)
                    : Effect.void;
                  const rollbackCredentials = sourceExists
                    ? fs
                        .rename(targetCredentials, sourceCredentials)
                        .pipe(Effect.ignore)
                    : Effect.void;

                  return moveCredentials.pipe(
                    Effect.flatMap(() => writeManifest(updated)),
                    Effect.onExit((exit) =>
                      Exit.isFailure(exit) ? rollbackCredentials : Effect.void,
                    ),
                    Effect.uninterruptible,
                  );
                },
              ),
            );
          });
          return [...new Set([name, newName])]
            .sort()
            .reduceRight(
              (effect, profileName) =>
                withProfileCredentialsLock(profileName, effect),
              locked,
            );
        }),
      );

    /** Locked read-modify-write of a profile that must already exist. */
    const updateManifestForProfile = (
      name: string,
      update: (manifest: ProfileManifest) => ProfileManifest,
    ): Effect.Effect<void, ProfileError | PlatformError> =>
      validateProfileName(name).pipe(
        Effect.flatMap(() =>
          modifyManifest(
            (manifest): Effect.Effect<void, ProfileError | PlatformError> =>
              name in manifest.profiles
                ? writeManifest(update(manifest))
                : Effect.fail(profileNotFound(name)),
          ),
        ),
      );

    const setProfile = (name: string, profile: Profile) =>
      updateManifestForProfile(name, (manifest) => ({
        ...manifest,
        profiles: { ...manifest.profiles, [name]: profile },
      }));

    const setDefaultProfile = (name: string) =>
      updateManifestForProfile(name, (manifest) => ({
        ...manifest,
        defaultProfile: name,
      }));

    const current: Effect.Effect<
      ProfileSelection,
      ProfileError | PlatformError
    > = Effect.gen(function* () {
      const configured = yield* Config.option(ALCHEMY_PROFILE).pipe(
        Effect.mapError(
          (cause) =>
            new ProfileError({
              message: "Could not resolve ALCHEMY_PROFILE.",
              cause,
            }),
        ),
      );
      if (Option.isSome(configured)) {
        const name = yield* validateProfileName(configured.value);
        return { name, source: "configuration" as const };
      }
      const manifest = yield* readManifest;
      if (manifest.defaultProfile) {
        const name = yield* validateProfileName(manifest.defaultProfile);
        return { name, source: "stored-default" as const };
      }
      return { name: "default", source: "fallback" as const };
    });

    const deleteProfile = (name: string) =>
      validateProfileName(name).pipe(
        Effect.flatMap(() =>
          modifyManifest(
            (
              manifest,
            ): Effect.Effect<boolean, ProfileError | PlatformError> => {
              if (!(name in manifest.profiles)) {
                return Effect.succeed(false);
              }
              if (name === defaultProfileName(manifest)) {
                return Effect.fail(cannotDeleteDefaultProfile(name));
              }
              const { [name]: _removed, ...profiles } = manifest.profiles;
              return writeManifest({ ...manifest, profiles }).pipe(
                Effect.as(true),
              );
            },
          ),
        ),
      );

    const loadOrConfigure = <Config extends { method: string }>(
      auth: AuthProvider<Config>,
      profileName: string,
      ctx: ConfigureContext,
    ): Effect.Effect<Config, AuthError | ProfileError | PlatformError> =>
      Effect.flatMap(ensureProfile(profileName), (existing) => {
        const stored = existing[auth.name];
        if (stored) {
          return Effect.succeed(stored as Config);
        }
        // No credentials are configured for this provider+profile. Driving
        // `auth.configure` requires an interactive terminal (clack prompts,
        // browser-based OAuth, ...). In a non-interactive, non-CI context
        // (e.g. a `vitest` run or piped stdout) there is no TTY to drive
        // those prompts, so bail *before* calling `auth.configure`.
        //
        // This matters beyond just avoiding a hang: `configure` is a locked
        // method, so entering it acquires a cross-process auth lockfile. We
        // must avoid creating that lock when we can't actually configure —
        // for OAuth providers a refresh token is typically single-use, so a
        // stray lock left by a doomed configure can wedge concurrent refreshes.
        if (!ctx.ci && isNonInteractive()) {
          return Effect.fail(
            new AuthError({
              message:
                `No credentials configured for '${auth.name}' in profile '${profileName}', ` +
                `and this process is non-interactive so it can't be configured interactively. ` +
                `Run \`alchemy profile edit ${profileName} --add ${auth.name}\` to configure it, ` +
                `or set CI=1 to use environment-variable credentials.`,
            }),
          );
        }
        return Effect.tap(auth.configure(profileName, ctx), (config) =>
          setProfile(profileName, { ...existing, [auth.name]: config }),
        );
      });

    return {
      readManifest,
      getProfile,
      ensureProfile,
      createProfile,
      renameProfile,
      setDefaultProfile,
      current,
      setProfile,
      deleteProfile,
      loadOrConfigure,
    } satisfies ProfileStoreService;
  }),
);

/** The name of the currently selected profile. */
export const currentProfileName: Effect.Effect<
  string,
  ProfileError | PlatformError,
  ProfileStore
> = ProfileStore.use((store) => store.current).pipe(
  Effect.map((selection) => selection.name),
);

/**
 * The shared preamble of every per-cloud `fromAuthProvider` /
 * `fromEnvironment` layer: look up the provider's {@link AuthProvider} in
 * the registry, resolve the current profile and the `CI` flag, and load
 * (or interactively configure) the provider's stored config.
 */
export const resolveProviderConfig = <
  C extends { method: string } = any,
  Credentials = any,
>(
  providerName: string,
) =>
  Effect.gen(function* () {
    const profile = yield* ProfileStore;
    const auth = yield* getAuthProvider<C, Credentials>(providerName);
    const { name: profileName } = yield* profile.current;
    const ci = yield* Config.boolean("CI").pipe(Config.withDefault(false));
    const config = yield* profile.loadOrConfigure(auth, profileName, { ci });
    return { auth, profileName, config };
  });

/**
 * Returns a `ConfigProvider` that overrides `ALCHEMY_PROFILE` with the
 * given `profile` (when explicitly passed via the CLI `--profile` flag),
 * falling through to `base` for everything else.
 *
 * Use this to let the CLI's `--profile <name>` win over `$ALCHEMY_PROFILE`
 * without disturbing other config lookups.
 */
export const withProfileOverride = (
  base: ConfigProvider.ConfigProvider,
  profile: string | undefined,
): ConfigProvider.ConfigProvider => {
  if (profile === undefined) return base;
  const overrides: Record<string, string> = { ALCHEMY_PROFILE: profile };
  const overrideProvider = ConfigProvider.make((path) =>
    Effect.succeed(
      path.length === 1 && typeof path[0] === "string" && path[0] in overrides
        ? ConfigProvider.makeValue(overrides[path[0]]!)
        : undefined,
    ),
  );
  return ConfigProvider.orElse(base)(overrideProvider);
};
