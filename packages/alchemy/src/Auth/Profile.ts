import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type { PlatformError } from "effect/PlatformError";
import { UserFacingError } from "../UserFacingError.ts";
import * as Path from "effect/Path";
import crypto from "node:crypto";
import path from "pathe";
import { writeFileAtomic } from "../Util/AtomicFile.ts";
import { profileCommandHint } from "../Util/interactive.ts";
import { AuthError } from "./AuthProvider.ts";
import type { AuthProvider } from "./AuthProvider.ts";
import { withLock, withProfileCredentialsLock } from "./Lock.ts";
import { configFilePath, profileCredentialsDirPath } from "./Paths.ts";

export {
  configFilePath,
  credentialsDirPath,
  profileCredentialsDirPath,
  rootDir,
} from "./Paths.ts";

/**
 * Config key consulted by the various `fromAuthProvider` /
 * `fromEnvironment` layers to pick which named profile in
 * `~/.alchemy/profiles.json` to use.
 */
export const ALCHEMY_PROFILE = Config.string("ALCHEMY_PROFILE");

export const PROFILE_MANIFEST_VERSION = 2;

/**
 * The built-in profile every command uses when `--profile` /
 * `$ALCHEMY_PROFILE` is absent — the same model as the AWS CLI's `default`
 * profile. It always exists, cannot be renamed or deleted, and there is no
 * stored "default selection" to change: any other profile must be named
 * explicitly.
 */
export const DEFAULT_PROFILE_NAME = "default";

/**
 * The id assigned to the built-in default profile. Deterministic (not
 * random) so a manifest that has never been written still presents the
 * same id on every read.
 */
export const DEFAULT_PROFILE_ID = "default";

/**
 * Configuration stored per provider inside a profile. `method` selects the
 * provider's auth flow (e.g. `oauth`, `stored`); the rest is provider-defined
 * and never contains secrets — those live in `~/.alchemy/credentials`.
 */
export interface ProviderConfig {
  method: string;
}

export interface Profile {
  /**
   * Stable identifier assigned when the profile is created (or migrated
   * from a pre-id manifest). Survives renames — reference a profile by id
   * when the reference must not break as the user reorganizes names.
   */
  id: string;
  providers: {
    [providerName: string]: ProviderConfig;
  };
}

export interface ProfileManifest {
  version: typeof PROFILE_MANIFEST_VERSION;
  profiles: Record<string, Profile>;
}

export interface ProfileSelection {
  readonly name: string;
  readonly source: "configuration" | "default";
}

const ProviderConfigSchema = Schema.StructWithRest(
  Schema.Struct({ method: Schema.String }),
  [Schema.Record(Schema.String, Schema.Unknown)],
);

const ProfileSchema = Schema.Struct({
  id: Schema.String,
  providers: Schema.Record(Schema.String, ProviderConfigSchema),
});

/** Pre-v2 profile shape: a bare provider-name → config record, no id. */
const LegacyProfileSchema = Schema.Record(Schema.String, ProviderConfigSchema);

// StructWithRest so unknown top-level keys written by a newer alchemy
// survive a read-modify-write cycle instead of being silently dropped.
// `defaultProfile` is decoded only so manifests written by the short-lived
// stored-default-selection scheme can be recognized and dropped on read.
const StoredManifestSchema = Schema.StructWithRest(
  Schema.Struct({
    version: Schema.Number,
    defaultProfile: Schema.optional(Schema.String),
    profiles: Schema.Record(
      Schema.String,
      Schema.Union([ProfileSchema, LegacyProfileSchema]),
    ),
  }),
  [Schema.Record(Schema.String, Schema.Unknown)],
);

export class ProfileError extends Schema.TaggedError<ProfileError>()(
  "ProfileError",
  {
    message: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  readonly [UserFacingError] = true;
}

/** A registry-only layer reached a provider with no stored configuration. */
export class MissingProviderConfig extends Schema.TaggedError<MissingProviderConfig>()(
  "MissingProviderConfig",
  {
    provider: Schema.String,
    profileName: Schema.String,
    message: Schema.String,
  },
) {}

/**
 * Registry-only consumers use this to ignore provider layers whose account
 * has not been connected yet. Normal commands surface an actionable
 * {@link AuthError}. Neither path starts configuration implicitly.
 */
export const SuppressMissingProviderConfig = Context.Reference<boolean>(
  "Auth/SuppressMissingProviderConfig",
  { defaultValue: () => false },
);

const emptyManifest = (): ProfileManifest => ({
  version: PROFILE_MANIFEST_VERSION,
  profiles: {},
});

/**
 * Guarantee the built-in `default` profile exists in a manifest. The
 * synthesized entry uses the deterministic {@link DEFAULT_PROFILE_ID} so it
 * is stable before the manifest is ever written; applying this on every
 * write persists it to disk.
 */
const withDefaultProfile = (manifest: ProfileManifest): ProfileManifest =>
  manifest.profiles[DEFAULT_PROFILE_NAME] !== undefined
    ? manifest
    : {
        ...manifest,
        profiles: {
          ...manifest.profiles,
          [DEFAULT_PROFILE_NAME]: { id: DEFAULT_PROFILE_ID, providers: {} },
        },
      };

export const createProfileHint = (name?: string) =>
  Effect.map(
    profileCommandHint(`alchemy profile create ${name ?? "<name>"}`),
    (command) => `Run \`${command}\`.`,
  );

const profileNotFound = Effect.fn(function* (name: string) {
  return new ProfileError({
    message: `Profile '${name}' does not exist. ${yield* createProfileHint(name)}`,
  });
});

/**
 * Shared by the store's locked `deleteProfile` check and the CLI's
 * friendlier pre-confirmation check, so the user-facing copy can't drift.
 */
export const cannotDeleteDefaultProfile = () =>
  new ProfileError({
    message: `Cannot delete the built-in '${DEFAULT_PROFILE_NAME}' profile.`,
  });

/** Same sharing rationale as {@link cannotDeleteDefaultProfile}. */
export const cannotRenameDefaultProfile = () =>
  new ProfileError({
    message: `Cannot rename the built-in '${DEFAULT_PROFILE_NAME}' profile.`,
  });

const PROFILE_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

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
   * Like {@link getProfile}, but fails with an actionable creation hint when
   * the named profile does not exist. The built-in `default` profile always
   * exists.
   */
  readonly ensureProfile: (
    name: string,
  ) => Effect.Effect<Profile, ProfileError | PlatformError>;
  readonly createProfile: (
    name: string,
  ) => Effect.Effect<void, ProfileError | PlatformError>;
  /** Rename a profile. The built-in `default` profile cannot be renamed. */
  readonly renameProfile: (
    name: string,
    newName: string,
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
   * doesn't exist. Fails when `name` is the built-in `default` profile,
   * which cannot be deleted.
   */
  readonly deleteProfile: (
    name: string,
  ) => Effect.Effect<boolean, ProfileError | PlatformError>;
  readonly loadProviderConfig: <Config extends { method: string }>(
    auth: AuthProvider<Config>,
    profileName: string,
  ) => Effect.Effect<
    Config,
    AuthError | MissingProviderConfig | ProfileError | PlatformError
  >;
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
    const pathService = yield* Path.Path;

    /**
     * The cross-process lock resolves FileSystem/Path from context; the
     * store's method signatures stay dependency-free, so satisfy the lock
     * from the services captured at layer build.
     */
    const provideLockServices = <A, E>(
      effect: Effect.Effect<A, E, FileSystem.FileSystem | Path.Path>,
    ): Effect.Effect<A, E> =>
      effect.pipe(
        Effect.provideService(FileSystem.FileSystem, fs),
        Effect.provideService(Path.Path, pathService),
      );

    /**
     * Legacy manifests recorded `method: "env"` entries for providers whose
     * credentials came from environment variables. Profiles no longer track
     * env-backed credentials (env vars resolve without any profile entry),
     * so those entries are dropped on read — the removal is persisted by the
     * next manifest write.
     */
    const dropLegacyEnvEntries = (
      providers: Profile["providers"],
    ): Profile["providers"] =>
      Object.fromEntries(
        Object.entries(providers).filter(([, cfg]) => cfg.method !== "env"),
      );

    /**
     * Normalize a decoded profile entry to the v2 shape. Pre-v2 entries are
     * bare provider maps without ids; they get the profile's name as its id,
     * which is deterministic across reads (a random id would drift until the
     * first write persisted it).
     */
    const normalizeProfile = (
      name: string,
      value: typeof ProfileSchema.Type | typeof LegacyProfileSchema.Type,
    ): Profile => {
      const current = Schema.decodeUnknownOption(ProfileSchema)(value);
      if (Option.isSome(current)) {
        return {
          id: current.value.id,
          providers: dropLegacyEnvEntries(current.value.providers),
        };
      }
      const providers = Schema.decodeUnknownSync(LegacyProfileSchema)(value);
      return {
        id: name,
        providers: dropLegacyEnvEntries(providers),
      };
    };

    const readManifest = Effect.suspend(() => {
      const manifestPath = configFilePath();
      return fs.readFileString(manifestPath).pipe(
        Effect.flatMap((data) =>
          Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown))(
            data,
          ).pipe(
            Effect.mapError(
              (cause) =>
                new ProfileError({
                  message: `Could not parse '${manifestPath}'. The file was left untouched.`,
                  cause,
                }),
            ),
          ),
        ),
        Effect.flatMap((json) =>
          Schema.decodeUnknownEffect(StoredManifestSchema)(json).pipe(
            Effect.mapError(
              (cause) =>
                new ProfileError({
                  message: `Invalid profile manifest at '${manifestPath}'. The file was left untouched.`,
                  cause,
                }),
            ),
          ),
        ),
        Effect.flatMap((stored) =>
          // Versions 0 and 1 (flat pre-id manifests) migrate in memory and
          // are upgraded on the next `writeManifest`, which always stamps
          // the current version.
          stored.version <= PROFILE_MANIFEST_VERSION
            ? Effect.sync(() => {
                // Manifests from the short-lived stored-default-selection
                // scheme carry a `defaultProfile` key; the built-in `default`
                // profile replaced it, so the key is dropped — the removal is
                // persisted by the next manifest write.
                const { defaultProfile: _dropped, ...rest } = stored;
                return {
                  ...rest,
                  version: PROFILE_MANIFEST_VERSION,
                  profiles: Object.fromEntries(
                    Object.entries(stored.profiles).map(([name, value]) => [
                      name,
                      normalizeProfile(name, value),
                    ]),
                  ),
                } satisfies ProfileManifest;
              })
            : Effect.fail(
                new ProfileError({
                  message:
                    `Profile manifest version ${stored.version} is not supported by this Alchemy version. ` +
                    "The file was left untouched.",
                }),
              ),
        ),
        Effect.catchReason("PlatformError", "NotFound", () =>
          Effect.succeed(emptyManifest()),
        ),
        // The built-in `default` profile always exists from the reader's
        // perspective; the synthesized entry is persisted by the next
        // manifest write.
        Effect.map(withDefaultProfile),
      );
    });

    const writeManifest = (config: ProfileManifest) =>
      Effect.suspend(() => {
        const manifestPath = configFilePath();
        return fs
          .makeDirectory(path.dirname(manifestPath), { recursive: true })
          .pipe(
            Effect.flatMap(() =>
              writeFileAtomic(
                fs,
                manifestPath,
                JSON.stringify(withDefaultProfile(config), null, 2),
                0o600,
              ),
            ),
          );
      });

    /**
     * Run `f` against the freshly-read manifest under the cross-process
     * manifest lock — the scaffold shared by every mutating store method.
     */
    const modifyManifest = <A>(
      f: (
        manifest: ProfileManifest,
      ) => Effect.Effect<A, ProfileError | PlatformError>,
    ): Effect.Effect<A, ProfileError | PlatformError> =>
      provideLockServices(
        withLock("profiles-manifest", Effect.flatMap(readManifest, f)),
      );

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
            const existing = manifest.profiles[name];
            return existing !== undefined
              ? Effect.succeed(existing)
              : Effect.flatMap(profileNotFound(name), Effect.fail);
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
                : Effect.sync(() => crypto.randomUUID()).pipe(
                    Effect.flatMap((id) =>
                      writeManifest({
                        ...manifest,
                        profiles: {
                          ...manifest.profiles,
                          [name]: { id, providers: {} },
                        },
                      }),
                    ),
                  ),
          ),
        ),
      );

    const renameProfile = (name: string, newName: string) =>
      Effect.gen(function* () {
        if (name === DEFAULT_PROFILE_NAME) {
          return yield* Effect.fail(cannotRenameDefaultProfile());
        }
        yield* validateProfileName(name);
        yield* validateProfileName(newName);
        return yield* Effect.gen(function* () {
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
                    Effect.onError(() => rollbackCredentials),
                    Effect.uninterruptible,
                  );
                },
              ),
            );
          });
          return yield* provideLockServices(
            [...new Set([name, newName])]
              .sort()
              .reduceRight(
                (
                  effect: Effect.Effect<
                    void,
                    ProfileError | PlatformError,
                    FileSystem.FileSystem | Path.Path
                  >,
                  profileName,
                ) => withProfileCredentialsLock(profileName, effect),
                locked,
              ),
          );
        });
      });

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
                : Effect.flatMap(profileNotFound(name), Effect.fail),
          ),
        ),
      );

    const setProfile = (name: string, profile: Profile) =>
      updateManifestForProfile(name, (manifest) => ({
        ...manifest,
        profiles: { ...manifest.profiles, [name]: profile },
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
      // No explicit selection — the built-in `default` profile, which
      // always exists. There is no stored default selection to consult.
      return { name: DEFAULT_PROFILE_NAME, source: "default" as const };
    });

    const deleteProfile = (name: string) =>
      validateProfileName(name).pipe(
        Effect.flatMap(() =>
          modifyManifest(
            (
              manifest,
            ): Effect.Effect<boolean, ProfileError | PlatformError> => {
              if (name === DEFAULT_PROFILE_NAME) {
                return Effect.fail(cannotDeleteDefaultProfile());
              }
              if (!(name in manifest.profiles)) {
                return Effect.succeed(false);
              }
              const { [name]: _removed, ...profiles } = manifest.profiles;
              return writeManifest({ ...manifest, profiles }).pipe(
                Effect.as(true),
              );
            },
          ),
        ),
      );

    const loadProviderConfig = <Config extends { method: string }>(
      auth: AuthProvider<Config>,
      profileName: string,
    ): Effect.Effect<
      Config,
      AuthError | MissingProviderConfig | ProfileError | PlatformError
    > =>
      Effect.gen(function* () {
        const existing = yield* ensureProfile(profileName);
        // Legacy `method: "env"` entries never reach this point — the
        // manifest reader drops them, so they resolve as "not configured".
        const stored = existing.providers[auth.name];
        if (stored) {
          // Manifest entries are user-editable JSON that may come from
          // another alchemy version; decode against the provider's schema
          // instead of trusting the shape.
          return yield* auth.decodeConfig(profileName, stored);
        }
        if (yield* SuppressMissingProviderConfig) {
          return yield* Effect.fail(
            new MissingProviderConfig({
              provider: auth.name,
              profileName,
              message: `No credentials configured for '${auth.name}' in profile '${profileName}'.`,
            }),
          );
        }
        return yield* Effect.fail(
          new AuthError({
            message:
              `No credentials configured for '${auth.name}' in profile '${profileName}'. ` +
              `Run \`${yield* profileCommandHint(`alchemy profile edit --profile ${profileName} --add ${auth.name}`)}\` to connect it.`,
          }),
        );
      });

    return {
      readManifest,
      getProfile,
      ensureProfile,
      createProfile,
      renameProfile,
      current,
      setProfile,
      deleteProfile,
      loadProviderConfig,
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
