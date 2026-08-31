import * as Clock from "effect/Clock";
import * as Config from "effect/Config";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Argument from "effect/unstable/cli/Argument";
import * as CliError from "effect/unstable/cli/CliError";
import * as Flag from "effect/unstable/cli/Flag";
import { isUserStage, localDevStage } from "../../Stage.ts";
import { UserInputError } from "./errors.ts";

export const USER = Config.string("USER").pipe(
  Config.orElse(() => Config.string("USERNAME")),
  Config.withDefault("unknown"),
);

export const STAGE = Config.string("STAGE").pipe(
  Config.option,
  Effect.map(Option.getOrUndefined),
);

const invalidUserStage = (value: string) =>
  new CliError.InvalidValue({
    option: "stage",
    value,
    expected:
      "a name matching [a-z0-9]+([-_a-z0-9]+)* (no ':'). alchemy dev uses local:<user>; tear it down with alchemy destroy --dev",
    kind: "flag",
  });

export const defaultDeployStage: Effect.Effect<string> = USER.pipe(
  Effect.map((user) => `dev_${user}`),
  Effect.catch(() => Effect.succeed("dev_unknown")),
);

export const localDevStageFromUser: Effect.Effect<string> = USER.pipe(
  Effect.map(localDevStage),
  Effect.catch(() => Effect.succeed(localDevStage("unknown"))),
);

/**
 * `--stage` on `alchemy dev`. Unlike {@link stage} this does not default:
 * `alchemy dev` always writes to `local:<user>`, and an explicit value is
 * rejected so a leftover `--stage prod` cannot hit the live row.
 */
export const rejectedDevStage = Flag.string("stage").pipe(
  Flag.withDescription(
    "Not used: alchemy dev always uses the engine-owned local:<user> stage. Tear it down with alchemy destroy --dev.",
  ),
  Flag.optional,
  Flag.map(Option.getOrUndefined),
);

export const stage = Flag.string("stage").pipe(
  Flag.withDescription("Stage to deploy to, defaults to dev_${USER}"),
  Flag.optional,
  Flag.map(Option.getOrUndefined),
  Flag.mapEffect(
    Effect.fn(function* (stage) {
      if (stage) {
        if (!isUserStage(stage)) {
          return yield* invalidUserStage(stage);
        }
        return stage;
      }
      return yield* STAGE.pipe(
        Effect.catch(() =>
          Effect.fail(new CliError.MissingOption({ option: "stage" })),
        ),
        Effect.flatMap((configured) => {
          if (configured === undefined) return defaultDeployStage;
          if (!isUserStage(configured)) {
            return invalidUserStage(configured);
          }
          return Effect.succeed(configured);
        }),
      );
    }),
  ),
);

/**
 * Target the engine-owned `local:<user>` stage instead of `--stage` / `$STAGE`
 * / `dev_$USER`. `alchemy dev` uses that stage unconditionally; pass `--dev`
 * on destroy/plan/logs/drift to address the same row.
 */
export const localDev = Flag.boolean("dev").pipe(
  Flag.withDescription(
    "Target the engine-owned local stage (local:<user>) used by alchemy dev",
  ),
  Flag.withDefault(false),
);

export const applyLocalDevStage = <
  A extends { readonly stage: string; readonly dev?: boolean },
>(
  args: A,
): Effect.Effect<A> =>
  args.dev
    ? localDevStageFromUser.pipe(Effect.map((stage) => ({ ...args, stage })))
    : Effect.succeed(args);

export const envFile = Flag.file("env-file").pipe(
  Flag.optional,
  Flag.withDescription(
    "File to load environment variables from, defaults to .env",
  ),
);

export const dryRun = Flag.boolean("dry-run").pipe(
  Flag.withDescription("Dry run the deployment, do not actually deploy"),
  Flag.withDefault(false),
);

export const yes = Flag.boolean("yes").pipe(
  Flag.withAlias("y"),
  Flag.withDescription("Yes to all prompts"),
  Flag.withDefault(false),
);

export const force = Flag.boolean("force").pipe(
  Flag.withDescription(
    "Force updates for resources that would otherwise no-op",
  ),
  Flag.withDefault(false),
);

export const config = Flag.file("config", { mustExist: true }).pipe(
  Flag.withDescription("Alchemy entrypoint file (default: alchemy.run.ts)"),
  Flag.withAlias("c"),
  Flag.withDefault("alchemy.run.ts"),
);

export const optionalConfig = Flag.file("config", { mustExist: true }).pipe(
  Flag.withDescription("Alchemy entrypoint file (default: alchemy.run.ts)"),
  Flag.withAlias("c"),
  Flag.optional,
  Flag.map(Option.getOrUndefined),
);

export const configPath = Argument.file("config", { mustExist: true }).pipe(
  Argument.withDescription("Alchemy entrypoint file (default: alchemy.run.ts)"),
  Argument.optional,
  Argument.map(Option.getOrUndefined),
);

export const resolveConfig = <
  A extends {
    readonly config: string | undefined;
    readonly configPath: string | undefined;
  },
>(
  args: A,
) =>
  Effect.gen(function* () {
    if (args.config !== undefined && args.configPath !== undefined) {
      return yield* new UserInputError({
        message:
          "Pass the config path either positionally or with --config, not both.",
      });
    }
    return {
      ...args,
      main: args.config ?? args.configPath ?? "alchemy.run.ts",
    };
  });

export const profile = Flag.string("profile").pipe(
  Flag.withDescription(
    "Auth profile to use. Defaults to $ALCHEMY_PROFILE or 'default'.",
  ),
  Flag.optional,
  Flag.map(Option.getOrUndefined),
);

export const parseSince = (value: string) =>
  Effect.gen(function* () {
    const match = value.match(/^(\d+)([smhd])$/);
    if (match) {
      const amount = match[1];
      const unit = match[2];
      if (amount === undefined || unit === undefined) {
        return yield* new UserInputError({
          message: `Invalid --since value: '${value}'.`,
        });
      }
      const num = parseInt(amount, 10);
      const duration =
        unit === "s"
          ? Duration.seconds(num)
          : unit === "m"
            ? Duration.minutes(num)
            : unit === "h"
              ? Duration.hours(num)
              : Duration.days(num);
      const now = yield* Clock.currentTimeMillis;
      return new Date(now - Duration.toMillis(duration));
    }
    const parsed = new Date(value);
    if (isNaN(parsed.getTime())) {
      return yield* new UserInputError({
        message: `Invalid --since value: '${value}'. Use a duration (e.g. '1h', '30m') or ISO date.`,
      });
    }
    return parsed;
  });
