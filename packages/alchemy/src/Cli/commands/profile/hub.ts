import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { defaultProfileName, ProfileStore } from "../../../Auth/Profile.ts";
import * as CliKit from "../../../Cli/CliKit/index.ts";
import { resolveProfileName } from "../../../Cli/ProfileSelection.ts";

import { isPromptCancellation, resolveProfileDisplay } from "../_shared.ts";
import {
  applyRename,
  collectAuthProviders,
  editProfileFlow,
  refreshProfileFlow,
  removeProfileWithCredentials,
} from "./flows.ts";

/**
 * The interactive hub behind bare `alchemy profile`: pick a profile (or
 * create one), then act on it. Every action delegates to the same flow the
 * corresponding subcommand runs, so the hub is purely a discovery layer.
 *
 * Prompt cancellation (Esc / Ctrl+C inside a nested prompt) backs out one
 * level instead of aborting the whole session; cancelling a top-level menu
 * exits the hub.
 */
export const profileHub = Effect.fn(function* (options: {
  envFile: Option.Option<string>;
  main: string;
}) {
  const { envFile, main } = options;
  const profiles = yield* ProfileStore;

  // Report a failed action inline and keep the hub session alive.
  const attempt = <A, E extends { message: string }, R>(
    fallback: A,
    eff: Effect.Effect<A, E | CliKit.InteractionError, R>,
  ): Effect.Effect<A, never, R> =>
    eff.pipe(
      Effect.catch((error) =>
        isPromptCancellation(error)
          ? Effect.succeed(fallback)
          : Effect.gen(function* () {
              const prompt = yield* CliKit.CliKit;
              yield* prompt.output.error(error.message);
              return fallback;
            }),
      ),
    );

  // Alphabetical — matches the tab order.
  const computeEntries = Effect.gen(function* () {
    const manifest = yield* profiles.readManifest;
    const activeProfile = yield* resolveProfileName(envFile, undefined);
    const defaultProfile = defaultProfileName(manifest);
    return Object.keys(manifest.profiles)
      .sort((a, b) => a.localeCompare(b))
      .map((name) => ({
        name,
        isActive: name === activeProfile,
        isDefault: name === defaultProfile,
      }));
  });
  let lastEntries: ReadonlyArray<{
    name: string;
    isActive: boolean;
    isDefault: boolean;
  }> = [];

  {
    // The store guarantees the default profile exists, so the dashboard
    // always has at least one row to land on.
    const { runProfileDashboardSession } = yield* Effect.promise(
      () => import("../../views/ProfileDashboard.tsx"),
    );
    const entries = yield* computeEntries;
    lastEntries = entries;

    // The session owns the terminal until the user quits; pure actions and
    // edit/refresh flows all share CliKit's application frame.
    yield* runProfileDashboardSession({
      entries,
      // Land on the last acted-on profile, else the active one.
      selected: entries.find((entry) => entry.isActive)?.name,
      loadDetails: (name) =>
        Effect.gen(function* () {
          // Read fresh — profiles can be created/renamed mid-session.
          const latest = yield* profiles.readManifest;
          const stored = latest.profiles[name]?.providers ?? {};
          const authProviders = yield* collectAuthProviders({
            main,
            envFile,
            profile: name,
          });
          const providers = yield* resolveProfileDisplay(
            name,
            stored,
            authProviders,
          );
          const available = Object.keys(authProviders)
            .filter((provider) => stored[provider] == null)
            .sort();
          return { providers, available };
        }).pipe(
          Effect.catch((e) =>
            Effect.succeed({
              providers: [
                {
                  name: "error",
                  method: "",
                  status: "error" as const,
                  lines: [e.message],
                },
              ],
              available: [],
            }),
          ),
        ),
      execute: (action) =>
        Effect.gen(function* () {
          switch (action.kind) {
            case "create": {
              yield* profiles.createProfile(action.name);
              return {
                message: `Created profile '${action.name}'.`,
                selected: action.name,
              };
            }
            case "rename": {
              const newName = yield* applyRename(action.name, action.newName);
              return {
                message: `Renamed '${action.name}' to '${newName}'.`,
                selected: newName,
              };
            }
            case "set-default": {
              yield* profiles.setDefaultProfile(action.name);
              return {
                message: `Default profile set to '${action.name}'.`,
                selected: action.name,
              };
            }
            case "delete": {
              yield* removeProfileWithCredentials(action.name);
              return {
                message: `Deleted '${action.name}' and its credentials.`,
                selected: undefined,
              };
            }
          }
        }).pipe(
          Effect.flatMap(({ message, selected: focus }) =>
            computeEntries.pipe(
              Effect.map((entries) => {
                lastEntries = entries;
                return { ok: true, message, entries, selected: focus };
              }),
            ),
          ),
          Effect.catch((e) =>
            Effect.succeed({
              ok: false,
              message: e.message,
              entries: lastEntries,
            }),
          ),
        ),
      runFlow: (action) =>
        Effect.gen(function* () {
          if (action.kind === "edit-apply") {
            yield* attempt(
              undefined,
              editProfileFlow({
                selectedProfile: action.name,
                add: action.add,
                reconfigure: action.reconfigure,
                remove: action.remove,
                envFile,
                main,
                printSummary: false,
              }),
            );
            return "Accounts updated.";
          }
          yield* attempt(
            undefined,
            refreshProfileFlow({
              selectedProfile: action.name,
              providers: [],
              envFile,
              main,
            }),
          );
          return "Credentials refreshed.";
        }),
      reloadEntries: computeEntries.pipe(
        Effect.map((entries) => {
          lastEntries = entries;
          return entries;
        }),
        Effect.catch(() => Effect.succeed(lastEntries)),
      ),
    });
  }
});
