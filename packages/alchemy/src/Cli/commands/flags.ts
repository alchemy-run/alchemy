import * as Clock from "effect/Clock";
import * as Config from "effect/Config";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Argument from "effect/unstable/cli/Argument";
import * as CliError from "effect/unstable/cli/CliError";
import * as Flag from "effect/unstable/cli/Flag";
import { isUserStage } from "../../Stage.ts";
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
    expected: "a name matching [a-z0-9]+([-_a-z0-9]+)*",
    kind: "flag",
  });

const defaultStage = (kind: "live" | "local") =>
  USER.pipe(
    Effect.map((user) => `${kind}_${user}`),
    Effect.catch(() => Effect.succeed(`${kind}_unknown`)),
  );

const makeStageFlag = (kind: "live" | "local") =>
  Flag.string("stage").pipe(
    Flag.withDescription(
      kind === "live"
        ? "Stage to target, defaults to live_${USER}"
        : "Stage to target, defaults to local_${USER}",
    ),
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
            if (configured === undefined) return defaultStage(kind);
            if (!isUserStage(configured)) {
              return invalidUserStage(configured);
            }
            return Effect.succeed(configured);
          }),
        );
      }),
    ),
  );

/** `--stage` for deploy / destroy / plan / logs / drift. Default: `live_$USER`. */
export const stage = makeStageFlag("live");

/** `--stage` for `alchemy dev`. Default: `local_$USER`. */
export const localStage = makeStageFlag("local");

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
