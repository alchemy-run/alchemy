import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Operation from "../../../AlchemyControl/Operation.ts";
import { ProfileControl } from "../../../AlchemyControl/ProfileControl.ts";
import * as CliKit from "../../../Cli/CliKit/index.ts";
import { isPromptCancellation, profileTui } from "../_shared.ts";

export type EditAction = "add" | "reconfigure" | "remove";
export interface EditOutcome {
  readonly provider: string;
  readonly action: EditAction;
  readonly outcome: "done" | "skipped" | "failed";
  readonly message?: string;
}

export const showProfileFlow = Effect.fn(function* (options: {
  profileName: string;
  activeProfile: string;
  envFile: Option.Option<string>;
  main: string;
}) {
  const profiles = yield* ProfileControl;
  const profile = yield* profiles.get({
    name: options.profileName,
    includeProviderStatus: true,
  });
  yield* Console.log(
    [
      `${profile.active ? "*" : "-"} ${profile.name}`,
      ...profile.providers.map((provider) =>
        [
          `  ${provider.name} (${provider.method}) — ${provider.status}`,
          ...provider.details.map(({ key, value }) => `    ${key}: ${value}`),
          ...(provider.diagnostic
            ? [`    ${provider.diagnostic.message}`]
            : []),
        ].join("\n"),
      ),
    ].join("\n"),
  );
});

export const renameProfileFlow = Effect.fn(function* (
  name: string,
  suppliedNewName: string | undefined,
) {
  const newName = (
    suppliedNewName ??
    (yield* CliKit.accessors.prompt.text({
      message: `Rename profile '${name}' to`,
      placeholder: `${name}-new`,
      validate: (value) =>
        value.trim().length > 0 ? undefined : "Profile name is required",
    }))
  ).trim();
  yield* (yield* ProfileControl).rename({ name, newName });
  yield* CliKit.accessors.output.success(
    `Renamed profile '${name}' to '${newName}'.`,
  );
  return newName;
});

export const deleteProfileFlow = Effect.fn(function* (options: {
  name: string;
  envFile: Option.Option<string>;
  main: string;
  yes: boolean;
}) {
  const profiles = yield* ProfileControl;
  const exists = yield* profiles
    .get({ name: options.name })
    .pipe(Effect.option);
  if (Option.isNone(exists)) {
    yield* Console.log(
      `Profile ${options.name}: Not found. Nothing was deleted.`,
    );
    return false;
  }
  if (
    !options.yes &&
    !(yield* CliKit.accessors.prompt.confirm({
      message: `Delete profile '${options.name}' and all its stored credentials? This cannot be undone.`,
      initialValue: false,
    }))
  ) {
    yield* CliKit.accessors.output.info("Aborted.");
    return false;
  }
  yield* profiles.delete({ name: options.name });
  yield* CliKit.accessors.output.success(
    `Deleted profile '${options.name}' and its credentials.`,
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
  printSummary?: boolean;
  continueOnError?: boolean;
  configureInput?: {
    method?: string;
    values: Record<string, string>;
  };
}) {
  const profiles = yield* ProfileControl;
  let plan: Array<{ provider: string; action: EditAction }> = [
    ...options.add.map((provider) => ({ provider, action: "add" as const })),
    ...options.reconfigure.map((provider) => ({
      provider,
      action: "reconfigure" as const,
    })),
    ...options.remove.map((provider) => ({
      provider,
      action: "remove" as const,
    })),
  ];

  if (plan.length === 0) {
    const profile = yield* profiles.get({
      name: options.selectedProfile,
    });
    const available = yield* profiles.providers({
      profile: options.selectedProfile,
      entrypoint: options.main,
      envFile: Option.getOrUndefined(options.envFile),
    });
    const connected = new Map(
      profile.providers.map((item) => [item.name, item]),
    );
    const names = [
      ...new Set([...connected.keys(), ...available.map(({ name }) => name)]),
    ].sort();
    const prompt = yield* CliKit.CliKit;
    const { editStateStyle } = yield* profileTui;
    const glyphs = CliKit.glyphsFor(prompt.terminal.unicode);
    const state = (
      key: keyof typeof editStateStyle,
      value: { provider: string; action: EditAction } | null,
    ) => ({
      value,
      icon: glyphs[editStateStyle[key].icon],
      label: editStateStyle[key].label,
      variant:
        key === "remove"
          ? ("error" as const)
          : key === "add"
            ? ("success" as const)
            : key === "reconfigure"
              ? ("accent" as const)
              : ("neutral" as const),
    });
    const choices = names.map((provider) =>
      connected.has(provider)
        ? {
            label: provider,
            description: connected.get(provider)!.method,
            states: [
              state("keep", null),
              state("reconfigure", { provider, action: "reconfigure" }),
              state("remove", { provider, action: "remove" }),
            ],
          }
        : {
            label: provider,
            states: [
              state("skip", null),
              state("add", { provider, action: "add" }),
            ],
          },
    );
    plan = (yield* prompt.prompt.cycle({
      message: `Manage accounts in profile '${options.selectedProfile}'`,
      options: choices,
      requireChange: true,
    })).filter((item) => item !== null);
  }

  const outcomes: EditOutcome[] = [];
  for (const step of plan) {
    const run =
      step.action === "remove"
        ? profiles.removeProvider({
            profile: options.selectedProfile,
            provider: step.provider,
            entrypoint: options.main,
            envFile: Option.getOrUndefined(options.envFile),
          })
        : profiles
            .configure({
              profile: options.selectedProfile,
              provider: step.provider,
              entrypoint: options.main,
              envFile: Option.getOrUndefined(options.envFile),
              action: step.action,
              method: options.configureInput?.method,
              values:
                options.configureInput === undefined
                  ? undefined
                  : Object.fromEntries(
                      Object.entries(options.configureInput.values).map(
                        ([key, value]) => [key, Redacted.make(value)],
                      ),
                    ),
            })
            .pipe(Effect.flatMap(Operation.result), Effect.asVoid);
    const result = yield* Effect.result(run);
    if (result._tag === "Success") {
      outcomes.push({ ...step, outcome: "done" });
    } else if (isPromptCancellation(result.failure)) {
      outcomes.push({ ...step, outcome: "skipped" });
    } else {
      const message =
        typeof result.failure === "object" &&
        result.failure !== null &&
        "message" in result.failure
          ? String(result.failure.message)
          : String(result.failure);
      outcomes.push({ ...step, outcome: "failed", message });
      if (!(options.continueOnError ?? false))
        return yield* Effect.fail(result.failure);
    }
  }
  return outcomes;
});
