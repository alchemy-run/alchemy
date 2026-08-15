import * as Cause from "effect/Cause";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as S from "effect/Schema";
import * as CliError from "effect/unstable/cli/CliError";

import { AuthError, type AuthProviders } from "../../../Auth/AuthProvider.ts";
import { CredentialsStore } from "../../../Auth/Credentials.ts";
import { withProfileCredentialsLock } from "../../../Auth/Lock.ts";
import {
  cannotDeleteDefaultProfile,
  defaultProfileName,
  ProfileError,
  ProfileStore,
  SuppressMissingProviderConfig,
  type ProfileManifest,
} from "../../../Auth/Profile.ts";
import * as CliKit from "../../../Cli/CliKit/index.ts";
import { resolveProfileName } from "../../../Cli/ProfileSelection.ts";

import {
  buildBuiltinAuthProviders,
  buildStackProviders,
  printProfile,
  profileTui,
} from "../_shared.ts";

export type EditAction = "add" | "reconfigure" | "remove";

/**
 * Layer builds can surface `MissingProviderConfig` as a failure or (via
 * `Layer.orDie` in provider compositions) a defect; schema-tagged errors
 * don't always survive `instanceof` across module boundaries, so match
 * structurally by tag.
 */
const isMissingProviderConfig = S.is(
  S.Struct({ _tag: S.Literals(["MissingProviderConfig"]) }),
);

/**
 * Populate an {@link AuthProviders} registry for display: the built-in
 * providers first, then the user's stack `providers()` layer on top so a
 * customized provider (same name) overrides the built-in one. A missing
 * conventional entrypoint leaves the built-ins in place; other import/build
 * failures are surfaced with their original diagnostics.
 *
 * Registration happens as a side effect of building each layer (see
 * `AuthProviderLayer`), and later builds overwrite earlier entries by name,
 * so build order is what gives the user's providers precedence.
 */
export const collectAuthProviders = Effect.fn("collectAuthProviders")(
  function* (options: {
    main: string;
    envFile: Option.Option<string>;
    profile: string;
  }) {
    const authProviders: AuthProviders["Service"] = {};

    // 1. Built-in providers first (baseline).
    yield* buildBuiltinAuthProviders({
      envFile: options.envFile,
      profile: options.profile,
      registry: authProviders,
    });

    // 2. The user's own providers() layer on top — building into the same
    //    registry overrides the built-ins by name. The conventional entrypoint
    //    is optional so built-ins work from any folder. If an entrypoint exists
    //    (or a different path was requested), loading errors are actionable and
    //    must surface instead of masquerading as a missing custom provider.
    const fs = yield* FileSystem.FileSystem;
    const entrypointExists = yield* fs.exists(options.main);
    const isMissingDefaultEntrypoint =
      options.main === "alchemy.run.ts" && !entrypointExists;
    if (!entrypointExists && !isMissingDefaultEntrypoint) {
      return yield* Effect.fail(
        new AuthError({
          message: `Stack entrypoint '${options.main}' does not exist.`,
        }),
      );
    }
    if (!isMissingDefaultEntrypoint) {
      yield* buildStackProviders({ ...options, registry: authProviders }).pipe(
        Effect.catchCause((cause) => {
          // A registry-only build reaching an unconfigured provider is
          // expected (the profile simply doesn't have that account yet) —
          // keep whatever registered; the built-ins above cover display.
          const suppressed = cause.reasons.some((reason) => {
            const error = Cause.isFailReason(reason)
              ? reason.error
              : Cause.isDieReason(reason)
                ? reason.defect
                : undefined;
            return isMissingProviderConfig(error);
          });
          return suppressed
            ? Effect.void
            : Effect.fail(
                new AuthError({
                  message: `Could not load auth providers from '${options.main}'.`,
                  cause,
                }),
              );
        }),
      );
    }

    return authProviders;
  },
  Effect.provideService(SuppressMissingProviderConfig, true),
);

/**
 * Core flows shared verbatim by the flag-driven subcommands and the
 * interactive hub (bare `alchemy profile`), so the two surfaces can never
 * drift: everything the hub offers is exactly what a subcommand runs.
 */

/**
 * Trim and apply a profile rename. The store validates names, refuses
 * collisions, moves the credential directory, and re-points the stored
 * default. Shared by {@link renameProfileFlow} and the dashboard's rename
 * action so the two surfaces can't diverge.
 */
export const applyRename = Effect.fn(function* (
  name: string,
  rawNewName: string,
) {
  const newName = rawNewName.trim();
  const profiles = yield* ProfileStore;
  yield* profiles.renameProfile(name, newName);
  return newName;
});

/**
 * Remove a profile's manifest entry and credential directory under the
 * profile lock. Manifest entry first: if credential deletion then fails,
 * the secrets remain recoverable as an orphaned directory; deleting
 * credentials first could leave a live/default profile pointing at secrets
 * that have already been destroyed. Shared by {@link deleteProfileFlow}
 * and the dashboard's delete action.
 */
export const removeProfileWithCredentials = Effect.fn(function* (name: string) {
  const profiles = yield* ProfileStore;
  const store = yield* CredentialsStore;
  yield* withProfileCredentialsLock(
    name,
    Effect.gen(function* () {
      yield* profiles.deleteProfile(name);
      yield* store.deleteProfile(name);
    }),
  );
});

export const listEntries = (manifest: ProfileManifest, activeProfile: string) =>
  Object.entries(manifest.profiles)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, stored]) => ({
      name,
      active: name === activeProfile,
      providers: Object.entries(stored.providers)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([name, config]) => ({ name, method: config.method })),
    }));

export const showProfileFlow = Effect.fn(function* (options: {
  profileName: string;
  activeProfile: string;
  envFile: Option.Option<string>;
  main: string;
}) {
  const { profileName, activeProfile, envFile, main } = options;
  const profiles = yield* ProfileStore;
  const manifest = yield* profiles.readManifest;
  const stored = manifest.profiles[profileName];
  if (stored == null) {
    const names = Object.keys(manifest.profiles).sort();
    return yield* Effect.fail(
      new ProfileError({
        message:
          `Profile '${profileName}' does not exist.` +
          (names.length > 0
            ? ` Available profiles: ${names.join(", ")}.`
            : ` Create it with \`alchemy profile create ${profileName}\`.`),
      }),
    );
  }

  const authProviders = yield* collectAuthProviders({
    main,
    envFile,
    profile: profileName,
  });

  yield* printProfile(
    profileName,
    stored.providers,
    authProviders,
    profileName === activeProfile,
  );
});

/** Rename `name`, prompting for the new name when not supplied. Returns the new name. */
export const renameProfileFlow = Effect.fn(function* (
  name: string,
  suppliedNewName: string | undefined,
) {
  const profiles = yield* ProfileStore;
  if (suppliedNewName === undefined) {
    if (!(yield* CliKit.CliKit).terminal.input) {
      return yield* Effect.fail(
        new AuthError({
          message:
            "A new profile name is required in a non-interactive session. " +
            `Run \`alchemy profile rename ${name} <new-name>\`.`,
        }),
      );
    }
    // The store re-checks this under its lock; failing here first
    // avoids prompting for a new name for a nonexistent profile.
    if ((yield* profiles.getProfile(name)) == null) {
      return yield* Effect.fail(
        new ProfileError({
          message: `Profile '${name}' does not exist.`,
        }),
      );
    }
  }
  const resolvedNewName = (
    suppliedNewName ??
    (yield* (yield* CliKit.CliKit).prompt.text({
      message: `Rename profile '${name}' to`,
      placeholder: `${name}-new`,
      validate: (value) =>
        value.trim().length > 0 ? undefined : "Profile name is required",
    }))
  ).trim();
  const finalName = yield* applyRename(name, resolvedNewName);
  yield* (yield* CliKit.CliKit).output.success(
    `Renamed profile '${name}' to '${finalName}'.`,
  );
  return finalName;
});

export const setDefaultFlow = Effect.fn(function* (name: string) {
  const profiles = yield* ProfileStore;
  yield* profiles.setDefaultProfile(name);
  yield* (yield* CliKit.CliKit).output.success(
    `Default profile set to '${name}'.`,
  );
});

/** Delete `name` after confirmation. Returns whether the profile was deleted. */
export const deleteProfileFlow = Effect.fn(function* (options: {
  name: string;
  envFile: Option.Option<string>;
  main: string;
  yes: boolean;
}) {
  const { name, envFile, main, yes } = options;
  const profiles = yield* ProfileStore;
  const manifest = yield* profiles.readManifest;
  const stored = manifest.profiles[name];
  if (stored == null) {
    const cli = yield* CliKit.CliKit;
    if (cli.terminal.input) {
      const { profileNoticeNode } = yield* profileTui;
      yield* cli.output.print(
        profileNoticeNode(name, "Not found. Nothing was deleted."),
      );
    } else {
      yield* Console.log(`Profile ${name}: Not found. Nothing was deleted.`);
    }
    return false;
  }
  // The store enforces this too, but failing before rendering
  // credentials and prompting for confirmation is friendlier.
  if (name === defaultProfileName(manifest)) {
    return yield* Effect.fail(cannotDeleteDefaultProfile(name));
  }

  const activeProfile = yield* resolveProfileName(envFile, undefined);
  const authProviders = yield* collectAuthProviders({
    main,
    envFile,
    profile: name,
  });
  yield* printProfile(
    name,
    stored.providers,
    authProviders,
    name === activeProfile,
  );

  const approved = yes
    ? true
    : yield* (yield* CliKit.CliKit).prompt.confirm({
        message:
          `Delete profile '${name}' and all its stored credentials? ` +
          "This cannot be undone.",
        initialValue: false,
      });
  if (!approved) {
    yield* (yield* CliKit.CliKit).output.info("Aborted.");
    return false;
  }

  yield* removeProfileWithCredentials(name);
  yield* (yield* CliKit.CliKit).output.success(
    `Deleted profile '${name}' and its credentials.`,
  );
  return true;
});

export const editProfileFlow = Effect.fn(function* (options: {
  selectedProfile: string;
  add: ReadonlyArray<string>;
  reconfigure: ReadonlyArray<string>;
  remove: ReadonlyArray<string>;
  envFile: Option.Option<string>;
  main: string;
  /** Print the resulting profile at the end. The dashboard re-renders the
   * same details itself, so it passes false. @default true */
  printSummary?: boolean;
  /**
   * Flag-driven configuration (`--method`/`--set`): configure the single
   * targeted provider via its `configureWith` instead of interactive
   * prompts. The command layer guarantees exactly one add/reconfigure
   * target when this is set.
   */
  configureInput?: {
    method?: string;
    values: Record<string, string>;
  };
}) {
  const { selectedProfile, add, reconfigure, remove, envFile, main } = options;
  const printSummary = options.printSummary ?? true;
  const profiles = yield* ProfileStore;
  // The default profile always exists; only explicitly named non-default
  // profiles must have been created first.
  let stored = yield* profiles.ensureProfile(selectedProfile);

  const authProviders = yield* collectAuthProviders({
    main,
    envFile,
    profile: selectedProfile,
  });
  const activeProfile = yield* resolveProfileName(envFile, undefined);

  const requireAuthProvider = (selectedProvider: string) => {
    const authProvider = authProviders[selectedProvider];
    return authProvider == null
      ? Effect.fail(
          new AuthError({
            message:
              `Auth provider '${selectedProvider}' is not registered. ` +
              "If it is a custom provider, pass its stack entrypoint with --config.",
          }),
        )
      : Effect.succeed(authProvider);
  };

  const configureProvider = Effect.fn(function* (
    selectedProvider: string,
    act: "add" | "reconfigure",
  ) {
    const authProvider = yield* requireAuthProvider(selectedProvider);
    const input = options.configureInput;
    let configured: (typeof stored.providers)[string];
    if (input !== undefined) {
      // Flag-driven path: values were resolved (env:/stdin) by the command
      // layer; validate against the provider's declared methods here.
      const methods = authProvider.configureMethods ?? [];
      if (authProvider.configureWith === undefined || methods.length === 0) {
        return yield* Effect.fail(
          new AuthError({
            message:
              `'${selectedProvider}' does not support flag-driven configuration; ` +
              "run `alchemy profile edit` in an interactive terminal instead.",
          }),
        );
      }
      const method =
        input.method ?? (methods.length === 1 ? methods[0]!.method : undefined);
      if (method === undefined) {
        return yield* Effect.fail(
          new AuthError({
            message:
              `'${selectedProvider}' has multiple configure methods; pass ` +
              `--method ${methods.map((m) => m.method).join(" | ")}.`,
          }),
        );
      }
      if (!methods.some((m) => m.method === method)) {
        return yield* Effect.fail(
          new AuthError({
            message:
              `'${selectedProvider}' has no method '${method}'. ` +
              `Available: ${methods.map((m) => m.method).join(", ")}.`,
          }),
        );
      }
      configured = yield* authProvider.configureWith(selectedProfile, {
        method,
        values: input.values,
      });
    } else {
      if (!(yield* CliKit.CliKit).terminal.input) {
        return yield* Effect.fail(
          new AuthError({
            message:
              `Cannot configure '${selectedProvider}' non-interactively. ` +
              "Pass --method/--set (see `alchemy provider list`), or run in an interactive terminal.",
          }),
        );
      }
      // Reconfigure passes the current entry as the starting point; an
      // invalid stored entry decodes to `undefined` so a fresh configure
      // heals it instead of failing before the user can fix anything.
      const current = stored.providers[selectedProvider];
      const currentConfig =
        current === undefined
          ? undefined
          : yield* authProvider
              .decodeConfig(selectedProfile, current)
              .pipe(Effect.orElseSucceed(() => undefined));
      configured = yield* authProvider.configure(
        selectedProfile,
        currentConfig,
      );
    }
    stored = {
      ...stored,
      providers: { ...stored.providers, [selectedProvider]: configured },
    };
    yield* profiles.setProfile(selectedProfile, stored);
    yield* (yield* CliKit.CliKit).output.success(
      `${act === "add" ? "Added" : "Updated"} '${selectedProvider}' in profile '${selectedProfile}'.`,
    );
  });

  const removeProvider = Effect.fn(function* (selectedProvider: string) {
    const authProvider = yield* requireAuthProvider(selectedProvider);
    // Both entry paths guarantee the provider is connected: direct mode
    // validates the plan up front, and the interactive menu only offers
    // delete on connected rows. An entry that no longer decodes is dropped
    // without provider logout — removal must not require valid config.
    const cfg = yield* authProvider
      .decodeConfig(selectedProfile, stored.providers[selectedProvider]!)
      .pipe(Effect.option);
    if (Option.isSome(cfg)) {
      yield* authProvider.logout(selectedProfile, cfg.value);
    } else {
      yield* (yield* CliKit.CliKit).output.info(
        `'${selectedProvider}' had an invalid stored entry; dropping it without provider logout.`,
      );
    }
    const { [selectedProvider]: _removed, ...remaining } = stored.providers;
    stored = { ...stored, providers: remaining };
    yield* profiles.setProfile(selectedProfile, stored);
    yield* (yield* CliKit.CliKit).output.success(
      `Removed '${selectedProvider}' from profile '${selectedProfile}'.`,
    );
  });

  const requested: Array<{ provider: string; action: EditAction }> = [
    ...add.map((provider) => ({ provider, action: "add" as const })),
    ...reconfigure.map((provider) => ({
      provider,
      action: "reconfigure" as const,
    })),
    ...remove.map((provider) => ({
      provider,
      action: "remove" as const,
    })),
  ];

  let plan: Array<{ provider: string; action: EditAction }>;
  let confirmDeletes: boolean;

  if (requested.length > 0) {
    // Direct mode: --add / --reconfigure / --remove <provider> flags.
    const resolveProvider = (input: string) =>
      [...Object.keys(stored.providers), ...Object.keys(authProviders)].find(
        (candidate) => candidate.toLowerCase() === input.toLowerCase(),
      ) ?? input;
    plan = requested.map(({ provider, action }) => ({
      provider: resolveProvider(provider),
      action,
    }));
    const seen = new Set<string>();
    for (const { provider, action } of plan) {
      if (seen.has(provider)) {
        return yield* Effect.fail(
          new AuthError({
            message: `Provider '${provider}' is listed more than once.`,
          }),
        );
      }
      seen.add(provider);
      const connected = provider in stored.providers;
      if (action === "add" && connected) {
        return yield* Effect.fail(
          new AuthError({
            message:
              `Provider '${provider}' is already connected in profile '${selectedProfile}'. ` +
              `Use \`alchemy profile edit --reconfigure ${provider}\` instead.`,
          }),
        );
      }
      if (action !== "add" && !connected) {
        return yield* Effect.fail(
          new AuthError({
            message:
              `Provider '${provider}' is not connected in profile '${selectedProfile}'.` +
              (action === "reconfigure"
                ? ` Use \`alchemy profile edit --add ${provider}\` instead.`
                : ""),
          }),
        );
      }
    }
    // Explicit --remove flags on the command line are their own
    // confirmation.
    confirmDeletes = false;
  } else {
    if (!(yield* CliKit.CliKit).terminal.input) {
      // The interactive menu can't run here — print the command's help
      // so the --add/--reconfigure/--remove flags are discoverable
      // from scripts and agents.
      yield* Console.error(
        "The interactive account menu requires a terminal; pass --add, --reconfigure, or --remove instead.",
      );
      return yield* Effect.fail(
        new CliError.ShowHelp({
          commandPath: ["alchemy", "profile", "edit"],
          errors: [
            new CliError.MissingOption({
              option: "add|--reconfigure|--remove",
            }),
          ],
        }),
      );
    }

    yield* printProfile(
      selectedProfile,
      stored.providers,
      authProviders,
      selectedProfile === activeProfile,
    );

    const allProviders = [
      ...new Set([
        ...Object.keys(authProviders),
        ...Object.keys(stored.providers),
      ]),
    ].sort();
    if (allProviders.length === 0) {
      yield* Console.log(
        "No AuthProviders registered. Make sure the stack's providers() layer includes AuthProviderLayer entries.",
      );
      return;
    }
    type EditStep = { provider: string; action: EditAction } | null;
    const { editStateStyle } = yield* profileTui;
    const prompt = yield* CliKit.CliKit;
    const glyphs = CliKit.glyphsFor(prompt.terminal.unicode);
    const stateFor = (
      state: keyof typeof editStateStyle,
      value: EditStep,
    ): CliKit.CycleChoice<EditStep>["states"][number] => ({
      value,
      icon: glyphs[editStateStyle[state].icon],
      label: editStateStyle[state].label,
      variant:
        state === "remove"
          ? "error"
          : state === "add"
            ? "success"
            : state === "reconfigure"
              ? "accent"
              : "neutral",
    });
    const options = allProviders.map(
      (provider): CliKit.CycleChoice<EditStep> => {
        const config = stored.providers[provider];
        return config == null
          ? {
              label: provider,
              states: [
                stateFor("skip", null),
                stateFor("add", { provider, action: "add" }),
              ],
            }
          : {
              label: provider,
              description: config.method,
              states: [
                stateFor("keep", null),
                stateFor("reconfigure", { provider, action: "reconfigure" }),
                stateFor("remove", { provider, action: "remove" }),
              ],
            };
      },
    );

    const selections = yield* prompt.prompt.cycle({
      message: `Manage accounts in profile '${selectedProfile}'`,
      options,
      requireChange: true,
    });
    plan = selections.filter((step) => step !== null);
    if (plan.length === 0) {
      yield* prompt.output.info("No changes.");
      return;
    }
    confirmDeletes = true;
  }

  for (const step of plan) {
    if (step.action === "remove") {
      if (confirmDeletes) {
        const approved = yield* (yield* CliKit.CliKit).prompt.confirm({
          message: `Remove '${step.provider}' from profile '${selectedProfile}'?`,
          initialValue: false,
        });
        if (!approved) {
          yield* (yield* CliKit.CliKit).output.info(
            `Skipped removing '${step.provider}'.`,
          );
          continue;
        }
      }
      yield* removeProvider(step.provider);
    } else {
      yield* configureProvider(step.provider, step.action);
    }
  }

  if (printSummary) {
    yield* Console.log("");
    yield* printProfile(
      selectedProfile,
      stored.providers,
      authProviders,
      selectedProfile === activeProfile,
    );
  }
});

export const refreshProfileFlow = Effect.fn(function* (options: {
  selectedProfile: string;
  providers: ReadonlyArray<string>;
  envFile: Option.Option<string>;
  main: string;
}) {
  const { selectedProfile, providers, envFile, main } = options;
  const profiles = yield* ProfileStore;
  const stored = yield* profiles.ensureProfile(selectedProfile);
  const authProviders = yield* collectAuthProviders({
    main,
    envFile,
    profile: selectedProfile,
  });
  const connected = Object.keys(stored.providers);

  const requested =
    providers.length === 0
      ? connected.sort()
      : providers.map(
          (input) =>
            connected.find(
              (provider) => provider.toLowerCase() === input.toLowerCase(),
            ) ?? input,
        );

  if (requested.length === 0) {
    yield* (yield* CliKit.CliKit).output.warning(
      `Profile '${selectedProfile}' has no connected providers to refresh.`,
    );
    return;
  }

  const seen = new Set<string>();
  for (const provider of requested) {
    if (seen.has(provider)) {
      return yield* Effect.fail(
        new AuthError({
          message: `Provider '${provider}' is listed more than once.`,
        }),
      );
    }
    seen.add(provider);
    const cfg = stored.providers[provider];
    if (cfg == null) {
      return yield* Effect.fail(
        new AuthError({
          message: `Provider '${provider}' is not connected in profile '${selectedProfile}'.`,
        }),
      );
    }
    if (authProviders[provider] == null) {
      return yield* Effect.fail(
        new AuthError({
          message:
            `Auth provider '${provider}' is not registered. ` +
            "If it is a custom provider, pass its stack entrypoint with --config.",
        }),
      );
    }
  }

  for (const provider of requested) {
    // An invalid stored entry cannot be refreshed — the decode error
    // carries the reconfigure hint.
    const config = yield* authProviders[provider]!.decodeConfig(
      selectedProfile,
      stored.providers[provider]!,
    );
    yield* authProviders[provider]!.login(selectedProfile, config);
  }
  yield* (yield* CliKit.CliKit).output.success(
    `Refreshed ${requested.length} provider${requested.length === 1 ? "" : "s"} in profile '${selectedProfile}'.`,
  );
});
