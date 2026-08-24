import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Operation from "../../../AlchemyControl/Operation.ts";
import { ProfileControl } from "../../../AlchemyControl/ProfileControl.ts";
import { DEFAULT_PROFILE_NAME } from "../../../Auth/Profile.ts";
import { isPromptCancellation } from "../_shared.ts";

export const profileHub = Effect.fn(function* (options: {
  envFile: Option.Option<string>;
  main: string;
}) {
  const profiles = yield* ProfileControl;
  const envFile = Option.getOrUndefined(options.envFile);
  const computeEntries = profiles.list().pipe(
    Effect.map((profiles) =>
      profiles.map((profile) => ({
        name: profile.name,
        isActive: profile.active,
        isDefault: profile.name === DEFAULT_PROFILE_NAME,
      })),
    ),
  );
  let lastEntries = yield* computeEntries;
  const { runProfileDashboardSession } = yield* Effect.promise(
    () => import("../../views/ProfileDashboard.tsx"),
  );

  yield* runProfileDashboardSession({
    entries: lastEntries,
    selected: lastEntries.find(({ isActive }) => isActive)?.name,
    loadDetails: (name) =>
      Effect.gen(function* () {
        const [profile, providers] = yield* Effect.all([
          profiles.get({ name, includeProviderStatus: true }),
          profiles.providers({
            profile: name,
            entrypoint: options.main,
            envFile,
          }),
        ]);
        return {
          providers: profile.providers.map((provider) => ({
            name: provider.name,
            method: provider.method,
            status:
              provider.status === "connected"
                ? ("configured" as const)
                : provider.status === "needs-reauth"
                  ? ("reauth" as const)
                  : ("error" as const),
            lines: [
              ...provider.details.map(({ key, value }) => `${key}: ${value}`),
              ...(provider.diagnostic ? [provider.diagnostic.message] : []),
            ],
          })),
          available: providers
            .filter(({ connected }) => !connected)
            .map(({ name }) => name),
        };
      }).pipe(
        Effect.catch((error) =>
          Effect.succeed({
            providers: [
              {
                name: "error",
                method: "",
                status: "error" as const,
                lines: [error.message],
              },
            ],
            available: [],
          }),
        ),
      ),
    execute: (action) =>
      Effect.gen(function* () {
        let selected: string | undefined;
        let message: string;
        if (action.kind === "create") {
          yield* profiles.create({ name: action.name });
          selected = action.name;
          message = `Created profile '${action.name}'.`;
        } else if (action.kind === "rename") {
          yield* profiles.rename({
            name: action.name,
            newName: action.newName,
          });
          selected = action.newName;
          message = `Renamed '${action.name}' to '${action.newName}'.`;
        } else {
          yield* profiles.delete({ name: action.name });
          message = `Deleted '${action.name}' and its credentials.`;
        }
        const entries = yield* computeEntries;
        lastEntries = entries;
        return { ok: true, message, entries, selected };
      }).pipe(
        Effect.catch((error) =>
          Effect.succeed({
            ok: false,
            message: error.message,
            entries: lastEntries,
          }),
        ),
      ),
    runFlow: (action, events) =>
      Effect.gen(function* () {
        if (action.kind === "refresh") {
          const operation = yield* profiles.refresh({
            profile: action.name,
            entrypoint: options.main,
            envFile,
          });
          yield* Operation.run(operation, (event) =>
            events.onProviderStart(event.provider),
          );
          return { ok: true, message: "Credentials refreshed." };
        }

        const outcomes: string[] = [];
        for (const provider of action.remove) {
          yield* profiles.removeProvider({
            profile: action.name,
            provider,
            entrypoint: options.main,
            envFile,
          });
          outcomes.push(`${provider} removed`);
        }
        for (const [kind, names] of [
          ["add", action.add],
          ["reconfigure", action.reconfigure],
        ] as const) {
          for (const provider of names) {
            const operation = yield* profiles.configure({
              profile: action.name,
              provider,
              entrypoint: options.main,
              envFile,
              action: kind,
            });
            yield* Operation.result(operation);
            outcomes.push(
              `${provider} ${kind === "add" ? "added" : "updated"}`,
            );
          }
        }
        return {
          ok: true,
          message: outcomes.length === 0 ? "No changes." : outcomes.join("; "),
        };
      }).pipe(
        Effect.catch((error) =>
          Effect.succeed(
            isPromptCancellation(error)
              ? { ok: true, message: "Cancelled." }
              : { ok: false, message: error.message },
          ),
        ),
      ),
    reloadEntries: computeEntries.pipe(
      Effect.tap((entries) => Effect.sync(() => (lastEntries = entries))),
      Effect.catch(() => Effect.succeed(lastEntries)),
    ),
  });
});
