import { unicodeOr } from "@clack/prompts";
import * as Config from "effect/Config";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { Command, Flag } from "effect/unstable/cli";
import * as Argument from "effect/unstable/cli/Argument";
import * as CliError from "effect/unstable/cli/CliError";

import { AuthError, AuthProviders } from "../../Auth/AuthProvider.ts";
import { CredentialsStore } from "../../Auth/Credentials.ts";
import { withProfileCredentialsLock } from "../../Auth/Lock.ts";
import {
  cannotDeleteDefaultProfile,
  defaultProfileName,
  ProfileError,
  ProfileStore,
  withProfileOverride,
  type ProfileManifest,
} from "../../Auth/Profile.ts";
import * as Clank from "../../Util/Clank.ts";
import { loadConfigProvider } from "../../Util/ConfigProvider.ts";
import { isNonInteractive } from "../../Util/interactive.ts";
import { styleText } from "node:util";

import {
  buildBuiltinAuthProviders,
  buildStackProviders,
  envFile,
  instrumentCommand,
  printProfile,
  profile,
  profileTui,
  resolveProfileDisplay,
  resolveProfileName,
  resolveProfileSelection,
  yes,
} from "./_shared.ts";

/**
 * Entrypoint whose `providers()` layer contributes the user's own auth
 * providers. Optional and best-effort — if it's missing or fails to load,
 * `profile show` still renders the built-in providers.
 */
const configFile = Flag.string("config").pipe(
  Flag.withDescription(
    "Stack entrypoint whose providers() should be used, defaults to alchemy.run.ts",
  ),
  Flag.optional,
  Flag.map(Option.getOrElse(() => "alchemy.run.ts")),
);

const showProfile = Argument.string("profile").pipe(
  Argument.withDescription("Profile to inspect"),
  Argument.optional,
);

const profileName = Argument.string("name").pipe(
  Argument.withDescription("Profile name"),
);

const newProfileName = Argument.string("new-name").pipe(
  Argument.withDescription("New profile name"),
  Argument.optional,
);

const editProfileName = Argument.string("profile").pipe(
  Argument.withDescription(
    "Profile whose connected accounts should be managed",
  ),
  Argument.optional,
);

const json = Flag.boolean("json").pipe(
  Flag.withDescription("Output machine-readable JSON instead of a table"),
  Flag.withDefault(false),
);

/**
 * Populate an {@link AuthProviders} registry for display: the built-in
 * providers first, then the user's stack `providers()` layer on top so a
 * customized provider (same name) overrides the built-in one. Loading the
 * user's stack is best-effort — a missing or invalid entrypoint leaves the
 * built-ins in place.
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
    //    registry overrides the built-ins by name. Best-effort: swallow
    //    load/build failures (including a missing entrypoint) so display
    //    still works with just the built-ins.
    yield* buildStackProviders({ ...options, registry: authProviders }).pipe(
      Effect.catchCause((cause) =>
        Effect.logDebug("profile show: could not load user stack providers", {
          cause,
        }),
      ),
    );

    return authProviders;
  },
);

/**
 * Core flows shared verbatim by the flag-driven subcommands and the
 * interactive hub (bare `alchemy profile`), so the two surfaces can never
 * drift: everything the hub offers is exactly what a subcommand runs.
 */

const listEntries = (manifest: ProfileManifest, activeProfile: string) =>
  Object.entries(manifest.profiles)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, stored]) => ({
      name,
      active: name === activeProfile,
      providers: Object.entries(stored)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([name, config]) => ({ name, method: config.method })),
    }));

const showProfileFlow = Effect.fn(function* (options: {
  profileName: string;
  activeProfile: string;
  envFile: Option.Option<string>;
  main: string;
  json: boolean;
}) {
  const { profileName, activeProfile, envFile, main, json } = options;
  const profiles = yield* ProfileStore;
  const manifest = yield* profiles.readManifest;
  // The default profile is implicit — render it empty instead of
  // "not found", without writing anything from a read command.
  const stored =
    manifest.profiles[profileName] ??
    (profileName === defaultProfileName(manifest) ? {} : undefined);
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

  if (json) {
    const providers = yield* resolveProfileDisplay(
      profileName,
      stored,
      authProviders,
    );
    return yield* Console.log(
      JSON.stringify(
        {
          profile: profileName,
          active: profileName === activeProfile,
          default: profileName === defaultProfileName(manifest),
          providers: providers.map(({ name, method, status, lines }) => ({
            name,
            method,
            status,
            details: lines,
          })),
        },
        null,
        2,
      ),
    );
  }

  yield* printProfile(
    profileName,
    stored,
    authProviders,
    profileName === activeProfile,
  );
});

/** Rename `name`, prompting for the new name when not supplied. Returns the new name. */
const renameProfileFlow = Effect.fn(function* (
  name: string,
  suppliedNewName: string | undefined,
) {
  const profiles = yield* ProfileStore;
  if (suppliedNewName === undefined) {
    if (isNonInteractive()) {
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
    (yield* Clank.text({
      message: `Rename profile '${name}' to`,
      placeholder: `${name}-new`,
      validate: (value) =>
        value.trim().length > 0 ? undefined : "Profile name is required",
    }))
  ).trim();
  yield* profiles.renameProfile(name, resolvedNewName);
  yield* Console.log(`Renamed profile '${name}' to '${resolvedNewName}'.`);
  return resolvedNewName;
});

const setDefaultFlow = Effect.fn(function* (name: string) {
  const profiles = yield* ProfileStore;
  yield* profiles.setDefaultProfile(name);
  yield* Console.log(`Default profile set to '${name}'.`);
});

/** Delete `name` after confirmation. Returns whether the profile was deleted. */
const deleteProfileFlow = Effect.fn(function* (options: {
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
    const { renderProfileNotice } = yield* profileTui;
    yield* Effect.sync(() =>
      renderProfileNotice(name, "Not found. Nothing was deleted."),
    );
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
  yield* printProfile(name, stored, authProviders, name === activeProfile);

  const approved = yes
    ? true
    : yield* Clank.confirm({
        message:
          `Delete profile '${name}' and all its stored credentials? ` +
          "This cannot be undone.",
        initialValue: false,
      });
  if (!approved) {
    yield* Console.log("Aborted.");
    return false;
  }

  const store = yield* CredentialsStore;
  yield* withProfileCredentialsLock(
    name,
    Effect.gen(function* () {
      yield* profiles.deleteProfile(name);
      // Remove the manifest entry first. If credential deletion then
      // fails, the secrets remain recoverable as an orphaned directory;
      // deleting credentials first could leave a live/default profile
      // pointing at secrets that have already been destroyed.
      yield* store.deleteProfile(name);
    }),
  );
  yield* Console.log(`Deleted profile '${name}' and its credentials.`);
  return true;
});

const showCommand = Command.make(
  "show",
  { name: showProfile, profile, envFile, main: configFile, json },
  instrumentCommand(
    "profile.show",
    (a: { name: Option.Option<string>; profile: string | undefined }) => ({
      "alchemy.profile": Option.getOrUndefined(a.name) ?? a.profile ?? "",
    }),
  )(
    Effect.fn(function* ({ name, profile, envFile, main, json }) {
      const activeProfile = yield* resolveProfileName(envFile, profile);
      const profileName = Option.getOrUndefined(name) ?? activeProfile;
      yield* showProfileFlow({
        profileName,
        activeProfile,
        envFile,
        main,
        json,
      });
    }),
  ),
).pipe(
  Command.withDescription(
    "Show connected providers, authentication status, and account details",
  ),
);

const listCommand = Command.make(
  "list",
  { envFile, json },
  instrumentCommand("profile.list")(
    Effect.fn(function* ({ envFile, json }) {
      const profiles = yield* ProfileStore;
      const manifest = yield* profiles.readManifest;
      const activeProfile = yield* resolveProfileName(envFile, undefined);
      const entries = listEntries(manifest, activeProfile);
      if (json) {
        const defaultProfile = defaultProfileName(manifest);
        return yield* Console.log(
          JSON.stringify(
            {
              activeProfile,
              defaultProfile,
              profiles: entries.map((entry) => ({
                ...entry,
                default: entry.name === defaultProfile,
              })),
            },
            null,
            2,
          ),
        );
      }
      const { renderProfileList } = yield* profileTui;
      yield* Effect.sync(() => renderProfileList(entries));
    }),
  ),
).pipe(Command.withDescription("List profiles and their connected providers"));

const createCommand = Command.make(
  "create",
  { name: profileName },
  instrumentCommand("profile.create", (a: { name: string }) => ({
    "alchemy.profile": a.name,
  }))(
    Effect.fn(function* ({ name }) {
      const profiles = yield* ProfileStore;
      yield* profiles.createProfile(name);
      yield* Console.log(
        `Created profile '${name}'. Run \`alchemy profile edit ${name}\` to connect accounts.`,
      );
    }),
  ),
).pipe(Command.withDescription("Create an empty authentication profile"));

const renameCommand = Command.make(
  "rename",
  { name: profileName, newName: newProfileName },
  instrumentCommand(
    "profile.rename",
    (a: { name: string; newName: Option.Option<string> }) => ({
      "alchemy.profile": a.name,
      "alchemy.profile.new_name": Option.getOrUndefined(a.newName) ?? "",
    }),
  )(
    Effect.fn(function* ({ name, newName }) {
      yield* renameProfileFlow(name, Option.getOrUndefined(newName));
    }),
  ),
).pipe(
  Command.withDescription(
    "Rename a profile and move all credentials stored for it",
  ),
);

type EditAction = "add" | "re-configure" | "delete";

const addProviders = Flag.string("add").pipe(
  Flag.withDescription("Connect a provider to the profile (repeatable)"),
  Flag.atLeast(0),
);

const reconfigureProviders = Flag.string("re-configure").pipe(
  Flag.withDescription(
    "Re-run a connected provider's configuration (repeatable)",
  ),
  Flag.atLeast(0),
);

const deleteProviders = Flag.string("delete").pipe(
  Flag.withDescription(
    "Log out a connected provider and disconnect it (repeatable)",
  ),
  Flag.atLeast(0),
);

const editCommand = Command.make(
  "edit",
  {
    name: editProfileName,
    profile,
    add: addProviders,
    reconfigure: reconfigureProviders,
    delete: deleteProviders,
    envFile,
    main: configFile,
  },
  instrumentCommand(
    "profile.edit",
    (a: {
      name: Option.Option<string>;
      profile: string | undefined;
      add: ReadonlyArray<string>;
      reconfigure: ReadonlyArray<string>;
      delete: ReadonlyArray<string>;
    }) => ({
      "alchemy.profile": Option.getOrUndefined(a.name) ?? a.profile ?? "",
      "alchemy.add": a.add.join(","),
      "alchemy.re_configure": a.reconfigure.join(","),
      "alchemy.delete": a.delete.join(","),
    }),
  )(
    Effect.fn(function* ({
      name,
      profile,
      add,
      reconfigure,
      delete: remove,
      envFile,
      main,
    }) {
      const selectedProfile =
        Option.getOrUndefined(name) ??
        (yield* resolveProfileName(envFile, profile));
      yield* editProfileFlow({
        selectedProfile,
        add,
        reconfigure,
        remove,
        envFile,
        main,
      });
    }),
  ),
).pipe(
  Command.withDescription(
    "Add, re-configure, or delete provider accounts in a profile",
  ),
);

const editProfileFlow = Effect.fn(function* (options: {
  selectedProfile: string;
  add: ReadonlyArray<string>;
  reconfigure: ReadonlyArray<string>;
  remove: ReadonlyArray<string>;
  envFile: Option.Option<string>;
  main: string;
}) {
  const { selectedProfile, add, reconfigure, remove, envFile, main } = options;
  const profiles = yield* ProfileStore;
  // The default profile is implicit — created on first use. Only
  // explicitly named non-default profiles must already exist.
  let stored = yield* profiles.ensureProfile(selectedProfile);

  const authProviders = yield* collectAuthProviders({
    main,
    envFile,
    profile: selectedProfile,
  });
  const activeProfile = yield* resolveProfileName(envFile, undefined);

  // The env file and selected profile are fixed for the whole command, so
  // resolve the config provider and CI flag once, not per provider.
  const commandConfig = withProfileOverride(
    yield* loadConfigProvider(envFile),
    selectedProfile,
  );
  const ci = yield* Config.boolean("CI").pipe(
    Config.withDefault(false),
    Effect.provideService(ConfigProvider.ConfigProvider, commandConfig),
  );

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
    act: "add" | "re-configure",
  ) {
    const authProvider = yield* requireAuthProvider(selectedProvider);
    if (!ci && isNonInteractive()) {
      return yield* Effect.fail(
        new AuthError({
          message:
            `Cannot configure '${selectedProvider}' non-interactively. ` +
            "Set CI=1 to configure it from environment variables.",
        }),
      );
    }
    const configured = yield* authProvider.configure(selectedProfile, {
      ci,
    });
    stored = { ...stored, [selectedProvider]: configured };
    yield* profiles.setProfile(selectedProfile, stored);
    yield* Console.log(
      `${act === "add" ? "Added" : "Updated"} '${selectedProvider}' in profile '${selectedProfile}'.`,
    );
  });

  const removeProvider = Effect.fn(function* (selectedProvider: string) {
    const authProvider = yield* requireAuthProvider(selectedProvider);
    // Both entry paths guarantee the provider is connected: direct mode
    // validates the plan up front, and the interactive menu only offers
    // delete on connected rows.
    yield* authProvider.logout(selectedProfile, stored[selectedProvider]!);
    const { [selectedProvider]: _removed, ...remaining } = stored;
    stored = remaining;
    yield* profiles.setProfile(selectedProfile, stored);
    yield* Console.log(
      `Removed '${selectedProvider}' from profile '${selectedProfile}'.`,
    );
  });

  const requested: Array<{ provider: string; action: EditAction }> = [
    ...add.map((provider) => ({ provider, action: "add" as const })),
    ...reconfigure.map((provider) => ({
      provider,
      action: "re-configure" as const,
    })),
    ...remove.map((provider) => ({
      provider,
      action: "delete" as const,
    })),
  ];

  let plan: Array<{ provider: string; action: EditAction }>;
  let confirmDeletes: boolean;

  if (requested.length > 0) {
    // Direct mode: --add / --re-configure / --delete <provider> flags.
    const resolveProvider = (input: string) =>
      [...Object.keys(stored), ...Object.keys(authProviders)].find(
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
      const connected = provider in stored;
      if (action === "add" && connected) {
        return yield* Effect.fail(
          new AuthError({
            message:
              `Provider '${provider}' is already connected in profile '${selectedProfile}'. ` +
              `Use \`alchemy profile edit --re-configure ${provider}\` instead.`,
          }),
        );
      }
      if (action !== "add" && !connected) {
        return yield* Effect.fail(
          new AuthError({
            message:
              `Provider '${provider}' is not connected in profile '${selectedProfile}'.` +
              (action === "re-configure"
                ? ` Use \`alchemy profile edit --add ${provider}\` instead.`
                : ""),
          }),
        );
      }
    }
    // Explicit --delete flags on the command line are their own
    // confirmation.
    confirmDeletes = false;
  } else {
    if (isNonInteractive()) {
      // The interactive menu can't run here — print the command's help
      // so the --add/--re-configure/--delete flags are discoverable
      // from scripts and agents.
      yield* Console.error(
        "The interactive account menu requires a terminal; pass --add, --re-configure, or --delete instead.",
      );
      return yield* Effect.fail(
        new CliError.ShowHelp({
          commandPath: ["alchemy", "profile", "edit"],
          errors: [
            new CliError.MissingOption({
              option: "add|--re-configure|--delete",
            }),
          ],
        }),
      );
    }

    yield* printProfile(
      selectedProfile,
      stored,
      authProviders,
      selectedProfile === activeProfile,
    );

    const allProviders = [
      ...new Set([...Object.keys(authProviders), ...Object.keys(stored)]),
    ].sort();
    if (allProviders.length === 0) {
      yield* Console.log(
        "No AuthProviders registered. Make sure the stack's providers() layer includes AuthProviderLayer entries.",
      );
      return;
    }
    type EditStep = { provider: string; action: EditAction } | null;
    const options = allProviders.map(
      (provider): Clank.CycleSelectOption<EditStep> => {
        const config = stored[provider];
        return config == null
          ? {
              label: provider,
              states: [
                {
                  value: null,
                  icon: styleText("dim", unicodeOr("○", "o")),
                },
                {
                  value: { provider, action: "add" },
                  icon: styleText("green", unicodeOr("✚", "+")),
                  annotation: styleText("green", "add"),
                },
              ],
            }
          : {
              label: provider,
              hint: config.method,
              states: [
                {
                  value: null,
                  icon: styleText("green", unicodeOr("●", "*")),
                },
                {
                  value: { provider, action: "re-configure" },
                  icon: styleText("yellow", unicodeOr("✎", "~")),
                  annotation: styleText("yellow", "re-configure"),
                },
                {
                  value: { provider, action: "delete" },
                  icon: styleText("red", unicodeOr("✖", "x")),
                  annotation: styleText("red", "remove"),
                },
              ],
            };
      },
    );

    const selections = yield* Clank.cycleSelect({
      message: `Manage accounts in profile '${selectedProfile}'`,
      options,
    });
    plan = selections.filter((step) => step !== null);
    if (plan.length === 0) {
      yield* Console.log("No changes.");
      return;
    }
    confirmDeletes = true;
  }

  for (const step of plan) {
    if (step.action === "delete") {
      if (confirmDeletes) {
        const approved = yield* Clank.confirm({
          message: `Remove '${step.provider}' from profile '${selectedProfile}'?`,
          initialValue: false,
        });
        if (!approved) {
          yield* Console.log(`Skipped removing '${step.provider}'.`);
          continue;
        }
      }
      yield* removeProvider(step.provider);
    } else {
      yield* configureProvider(step.provider, step.action);
    }
  }

  yield* Console.log("");
  yield* printProfile(
    selectedProfile,
    stored,
    authProviders,
    selectedProfile === activeProfile,
  );
});

const setDefaultCommand = Command.make(
  "set-default",
  { name: profileName },
  instrumentCommand("profile.set-default", (a: { name: string }) => ({
    "alchemy.profile": a.name,
  }))(
    Effect.fn(function* ({ name }) {
      yield* setDefaultFlow(name);
    }),
  ),
).pipe(Command.withDescription("Set the default profile for future commands"));

const currentCommand = Command.make(
  "current",
  { envFile, json },
  instrumentCommand("profile.current")(
    Effect.fn(function* ({ envFile, json }) {
      const selected = yield* resolveProfileSelection(envFile, undefined);
      if (json) {
        return yield* Console.log(
          JSON.stringify(
            { name: selected.name, source: selected.source },
            null,
            2,
          ),
        );
      }
      const source =
        selected.source === "configuration"
          ? "ALCHEMY_PROFILE"
          : selected.source === "stored-default"
            ? "stored default"
            : "built-in fallback";
      const { renderCurrentProfile } = yield* profileTui;
      yield* Effect.sync(() => renderCurrentProfile(selected.name, source));
    }),
  ),
).pipe(
  Command.withDescription("Show the effective profile and how it was selected"),
);

const deleteCommand = Command.make(
  "delete",
  { name: profileName, envFile, main: configFile, yes },
  instrumentCommand("profile.delete", (a: { name: string; yes: boolean }) => ({
    "alchemy.profile": a.name,
    "alchemy.yes": a.yes,
  }))(
    Effect.fn(function* ({ name, envFile, main, yes }) {
      yield* deleteProfileFlow({ name, envFile, main, yes });
    }),
  ),
).pipe(
  Command.withDescription("Delete a profile and all credentials stored for it"),
);

/**
 * The interactive hub behind bare `alchemy profile`: pick a profile (or
 * create one), then act on it. Every action delegates to the same flow the
 * corresponding subcommand runs, so the hub is purely a discovery layer.
 *
 * Prompt cancellation (Esc / Ctrl+C inside a nested prompt) backs out one
 * level instead of aborting the whole session; cancelling a top-level menu
 * exits the hub.
 */
const profileHub = Effect.fn(function* (options: {
  envFile: Option.Option<string>;
  main: string;
}) {
  const { envFile, main } = options;
  const profiles = yield* ProfileStore;

  // Report a failed action inline and keep the hub session alive.
  const attempt = <A, E extends { message: string }, R>(
    fallback: A,
    eff: Effect.Effect<A, E | Clank.PromptCancelled, R>,
  ): Effect.Effect<A, never, R> =>
    eff.pipe(
      Effect.catchTag("PromptCancelled", () => Effect.succeed(fallback)),
      Effect.catch((e) => Clank.error(e.message).pipe(Effect.as(fallback))),
    );

  while (true) {
    const manifest = yield* profiles.readManifest;
    const activeProfile = yield* resolveProfileName(envFile, undefined);
    const defaultProfile = defaultProfileName(manifest);
    const { renderProfileList } = yield* profileTui;
    yield* Effect.sync(() =>
      renderProfileList(listEntries(manifest, activeProfile)),
    );

    type Target = { kind: "profile"; name: string } | "create" | "exit";
    const target = yield* Clank.select<Target>({
      message: "Select a profile",
      options: [
        ...Object.keys(manifest.profiles)
          .sort()
          .map((name) => {
            const tags = [
              name === defaultProfile ? "default" : undefined,
              name === activeProfile ? "active" : undefined,
            ].filter((tag) => tag !== undefined);
            return {
              value: { kind: "profile", name } as const,
              label: name,
              hint: tags.length > 0 ? tags.join(", ") : undefined,
            };
          }),
        { value: "create" as const, label: "Create a new profile" },
        { value: "exit" as const, label: "Exit" },
      ],
    });
    if (target === "exit") return;

    let selected: string;
    if (target === "create") {
      const name = (yield* Clank.text({
        message: "New profile name",
        validate: (value) =>
          value.trim().length > 0 ? undefined : "Profile name is required",
      })).trim();
      const created = yield* attempt(
        false,
        profiles.createProfile(name).pipe(
          Effect.tap(() => Console.log(`Created profile '${name}'.`)),
          Effect.as(true),
        ),
      );
      if (!created) continue;
      selected = name;
    } else {
      selected = target.name;
    }

    let leave: "list" | "hub" | undefined;
    while (leave === undefined) {
      const latest = yield* profiles.readManifest;
      const isDefault = selected === defaultProfileName(latest);
      type Action =
        | "show"
        | "edit"
        | "rename"
        | "set-default"
        | "delete"
        | "back"
        | "exit";
      const action = yield* Clank.select<Action>({
        message: `Profile '${selected}'`,
        options: [
          { value: "show", label: "Show details" },
          { value: "edit", label: "Edit accounts" },
          { value: "rename", label: "Rename" },
          ...(isDefault
            ? []
            : [
                { value: "set-default" as const, label: "Set as default" },
                { value: "delete" as const, label: "Delete" },
              ]),
          { value: "back", label: "Back" },
          { value: "exit", label: "Exit" },
        ],
      });
      switch (action) {
        case "show": {
          const activeProfile = yield* resolveProfileName(envFile, undefined);
          yield* attempt(
            undefined,
            showProfileFlow({
              profileName: selected,
              activeProfile,
              envFile,
              main,
              json: false,
            }),
          );
          break;
        }
        case "edit": {
          yield* attempt(
            undefined,
            editProfileFlow({
              selectedProfile: selected,
              add: [],
              reconfigure: [],
              remove: [],
              envFile,
              main,
            }),
          );
          break;
        }
        case "rename": {
          selected = yield* attempt(
            selected,
            renameProfileFlow(selected, undefined),
          );
          break;
        }
        case "set-default": {
          yield* attempt(undefined, setDefaultFlow(selected));
          break;
        }
        case "delete": {
          const deleted = yield* attempt(
            false,
            deleteProfileFlow({ name: selected, envFile, main, yes: false }),
          );
          if (deleted) leave = "list";
          break;
        }
        case "back": {
          leave = "list";
          break;
        }
        case "exit": {
          leave = "hub";
          break;
        }
      }
    }
    if (leave === "hub") return;
  }
});

export const profileCommand = Command.make(
  "profile",
  { envFile, main: configFile },
  instrumentCommand("profile")(
    Effect.fn(function* ({ envFile, main }) {
      if (isNonInteractive()) {
        // No terminal to drive the hub — show the subcommand help instead,
        // which documents the flag-driven equivalents of every hub action.
        return yield* Effect.fail(
          new CliError.ShowHelp({
            commandPath: ["alchemy", "profile"],
            errors: [],
          }),
        );
      }
      yield* profileHub({ envFile, main });
    }),
  ),
).pipe(
  Command.withDescription(
    "Manage authentication profiles and accounts (interactive without a subcommand)",
  ),
  Command.withSubcommands([
    createCommand,
    renameCommand,
    editCommand,
    listCommand,
    showCommand,
    currentCommand,
    setDefaultCommand,
    deleteCommand,
  ]),
);
