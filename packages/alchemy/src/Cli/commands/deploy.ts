import * as Cause from "effect/Cause";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Command from "effect/unstable/cli/Command";
import * as Flag from "effect/unstable/cli/Flag";

import * as Operation from "../../AlchemyControl/Operation.ts";
import { StackControl } from "../../AlchemyControl/StackLifecycle.ts";
import * as CLI from "../../Cli/Cli.ts";

import {
  config,
  dryRun as dryRunFlag,
  envFile,
  force,
  instrumentCommand,
  profile,
  stage,
  yes,
} from "./_shared.ts";

export const ExecStackOptions = Schema.Struct({
  main: Schema.String,
  stage: Schema.String,
  envFile: Schema.OptionFromOptional(Schema.String),
  profile: Schema.optional(Schema.String),
  dryRun: Schema.optional(Schema.Boolean),
  force: Schema.optional(Schema.Boolean),
  yes: Schema.optional(Schema.Boolean),
  destroy: Schema.optional(Schema.Boolean),
  dev: Schema.optional(Schema.Boolean),
  adopt: Schema.optional(Schema.Boolean),
  detailed: Schema.optional(Schema.Boolean),
});
export type ExecStackOptions = typeof ExecStackOptions.Type;
export type ExecStackOptionsEncoded = typeof ExecStackOptions.Encoded;

const stackSpanAttrs = (args: ExecStackOptions) => ({
  "alchemy.stage": args.stage,
  "alchemy.profile": args.profile,
  "alchemy.main": args.main,
  "alchemy.dry_run": !!args.dryRun,
  "alchemy.force": !!args.force,
  "alchemy.destroy": !!args.destroy,
  "alchemy.dev": !!args.dev,
  "alchemy.adopt": !!args.adopt,
  "alchemy.detailed": !!args.detailed,
});

const adopt = Flag.boolean("adopt").pipe(
  Flag.withDescription(
    "Adopt pre-existing cloud resources that conflict with this stack instead of failing. " +
      "Useful for re-importing infrastructure into a fresh state store.",
  ),
  Flag.withDefault(false),
);

const detailed = Flag.boolean("detailed").pipe(
  Flag.withDescription("Show declared resource properties as YAML"),
  Flag.withDefault(false),
);

const routeStack = Effect.fn(function* (options: ExecStackOptions) {
  const cli = yield* CLI.Cli;
  const stacks = yield* StackControl;
  if (options.dev) {
    const operation = yield* stacks.dev.reconcile({
      target: {
        entrypoint: options.main,
        stage: options.stage,
        profile: options.profile,
        envFile: Option.getOrUndefined(options.envFile),
      },
      force: options.force,
    });
    let session: CLI.PlanStatusSession | undefined;
    const result = yield* Operation.run(operation, (event) => {
      if (event._tag === "PlanReady") {
        const snapshot = event.snapshot;
        return cli
          .startApplySession(snapshot.native, {
            detailed: options.detailed,
            stage: options.stage,
          })
          .pipe(Effect.tap((next) => Effect.sync(() => (session = next))));
      }
      return event._tag === "ApplyEvent" && session !== undefined
        ? session.emit(event.event)
        : Effect.void;
    }).pipe(
      Effect.tapError(() =>
        session === undefined ? Effect.void : session.done("failure"),
      ),
    );
    const devOnce =
      process.env.ALCHEMY_DEV_ONCE === "1" ||
      process.env.ALCHEMY_DEV_ONCE === "true";
    if (session !== undefined) yield* session.done("success");
    if (result !== undefined) yield* Console.log(result);
    return devOnce ? undefined : yield* Effect.never;
  }

  const operation = options.destroy
    ? "Destroy"
    : options.dryRun
      ? "Plan"
      : "Deploy";
  const planning = yield* cli.startPlanningSession(
    "Importing stack module",
    options.stage,
    `${operation} · ${options.stage}`,
  );
  const planOperation = yield* options.destroy
    ? stacks.destroy.plan({
        target: {
          entrypoint: options.main,
          stage: options.stage,
          profile: options.profile,
          envFile: Option.getOrUndefined(options.envFile),
        },
        force: options.force,
        adopt: options.adopt,
        updateStateStore: options.yes,
      })
    : stacks.plan({
        target: {
          entrypoint: options.main,
          stage: options.stage,
          profile: options.profile,
          envFile: Option.getOrUndefined(options.envFile),
        },
        operation: "deploy",
        force: options.force,
        adopt: options.adopt,
        updateStateStore: options.yes,
      });
  const snapshot = yield* Operation.run(planOperation, (event) =>
    event.phase === "plan-ready"
      ? planning.succeed(event.message)
      : planning.update(event.message, options.stage),
  ).pipe(
    Effect.tapError(() => planning.fail("Planning failed")),
    Effect.onInterrupt(() => planning.close),
  );

  if (options.dryRun) {
    return yield* cli.displayPlan(snapshot.native, {
      detailed: options.detailed,
      stage: options.stage,
    });
  }

  const hasChanges =
    snapshot.summary.create +
      snapshot.summary.update +
      snapshot.summary.replace +
      snapshot.summary.delete >
    0;
  if (
    !options.yes &&
    hasChanges &&
    !(yield* cli.approvePlan(snapshot.native, {
      detailed: options.detailed,
      stage: options.stage,
    }))
  ) {
    return;
  }

  const session = yield* cli.startApplySession(snapshot.native, {
    detailed: options.detailed,
    stage: options.stage,
  });
  const applyOperation = yield* (
    options.destroy ? stacks.destroy.apply : stacks.deploy
  )({
    planId: snapshot.id,
    revision: snapshot.revision,
  });
  const result = yield* Operation.run(applyOperation, (event) =>
    session.emit(event.event),
  ).pipe(Effect.tapError(() => session.done("failure")));
  yield* session.done("success");
  if (result !== undefined) yield* Console.log(result);
});

// In dev, failures OUTSIDE the apply guard above must not exit the process
// either: the user saves mid-edit states where importing the stack module
// itself throws (missing export, module-evaluation crash), or planning fails
// against the half-edited program. Those failures escape the route before
// the apply-level guard exists, and exiting here kills the `--watch` session
// (oven-sh/bun#10983), so dev would stop reloading on subsequent saves. Log
// the cause and park forever; the watcher restarts the run on the next file
// change. Pure interruption (Ctrl-C / fiber kill) still propagates so dev
// shuts down cleanly.
export const devKeepAlive = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
  effect.pipe(
    Effect.catchCause((cause) =>
      Cause.hasInterruptsOnly(cause)
        ? Effect.failCause(cause)
        : Console.error(
            `alchemy dev: run failed; waiting for the next file change to retry.\n${Cause.pretty(cause)}`,
          ).pipe(Effect.andThen(Effect.never)),
    ),
  );

export const execStack = (options: ExecStackOptions) =>
  options.dev ? devKeepAlive(routeStack(options)) : routeStack(options);

export const deployCommand = Command.make(
  "deploy",
  {
    dryRun: dryRunFlag,
    force,
    main: config,
    envFile,
    stage,
    yes,
    profile,
    adopt,
    detailed,
  },
  instrumentCommand("deploy", stackSpanAttrs)(execStack),
);

export const destroyCommand = Command.make(
  "destroy",
  {
    dryRun: dryRunFlag,
    main: config,
    envFile,
    stage,
    yes,
    profile,
  },
  instrumentCommand(
    "destroy",
    stackSpanAttrs,
  )((args) =>
    execStack({
      ...args,
      destroy: true,
    }),
  ),
);

export const planCommand = Command.make(
  "plan",
  {
    main: config,
    envFile,
    stage,
    profile,
    detailed,
  },
  instrumentCommand(
    "plan",
    stackSpanAttrs,
  )((args) =>
    execStack({
      ...args,
      // plan is the same as deploy with dryRun always set to true
      dryRun: true,
    }),
  ),
);
