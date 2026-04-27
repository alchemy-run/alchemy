import * as ConfigProvider from "effect/ConfigProvider";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import { Argument, Command, Flag } from "effect/unstable/cli";

import { AuthProviders } from "../../src/Auth/AuthProvider.ts";
import { withProfileOverride } from "../../src/Auth/Profile.ts";
import { Stage } from "../../src/Stage.ts";
import * as State from "../../src/State/index.ts";
import { encodeState } from "../../src/State/StateEncoding.ts";
import { loadConfigProvider } from "../../src/Util/ConfigProvider.ts";
import { fileLogger } from "../../src/Util/FileLogger.ts";

import { envFile, importStack, main, profile, stage } from "./_shared.ts";

/**
 * When set, the State service is replaced with the on-disk
 * `LocalState` (`.alchemy/state` under the cwd) instead of whatever
 * the stack file configures (e.g. the Cloudflare HTTP state store).
 * Useful for inspecting orphaned local state after a partially-failed
 * bootstrap.
 */
const localFlag = Flag.boolean("local").pipe(
  Flag.withDescription("Read from local .alchemy/state instead of the stack's configured state store"),
  Flag.withDefault(false),
);

const stackArg = Argument.string("stack").pipe(
  Argument.withDescription("Stack name (e.g. AlchemyEffectWebsite)"),
);

const stageArg = Argument.string("stage").pipe(
  Argument.withDescription("Stage name (e.g. dev_samgoodwin, prod)"),
);

const fqnArg = Argument.string("fqn").pipe(
  Argument.withDescription("Fully-qualified resource name"),
);

/**
 * Build the layer stack used by every `alchemy state ...` subcommand.
 *
 * The stack file is imported and evaluated so that its `state` layer
 * (Cloudflare HTTP store, in-memory, etc.) is in scope. Pass `local`
 * to swap the configured State for an on-disk LocalState instead.
 */
const withStateService = <A, E>(
  args: {
    main: string;
    stage: string;
    envFile: import("effect/Option").Option<string>;
    profile: string;
    local: boolean;
  },
  body: (state: State.StateService) => Effect.Effect<A, E, never>,
) =>
  Effect.gen(function* () {
    const stackEffect = yield* importStack(args.main);

    const services = Layer.mergeAll(
      Layer.succeed(AuthProviders, {}),
      ConfigProvider.layer(
        withProfileOverride(yield* loadConfigProvider(args.envFile), args.profile),
      ),
      Logger.layer([fileLogger("out")]),
      Layer.succeed(Stage, args.stage),
      // When --local is set we still build the stack to get its other
      // services, but force State to be LocalState. Without --local the
      // stack's configured State (httpState, etc.) wins.
      args.local ? State.localState() : Layer.empty,
    );

    return yield* Effect.gen(function* () {
      const stack = yield* stackEffect;
      return yield* Effect.gen(function* () {
        const state = yield* State.State;
        return yield* body(state);
      }).pipe(Effect.provide(stack.services));
    }).pipe(Effect.provide(services));
  });

const stacksCommand = Command.make(
  "stacks",
  { main, envFile, stage, profile, local: localFlag },
  Effect.fnUntraced(function* (args) {
    yield* withStateService(args, (state) =>
      Effect.gen(function* () {
        const stacks = yield* state.listStacks();
        if (stacks.length === 0) {
          yield* Console.log("(no stacks)");
          return;
        }
        for (const s of [...stacks].sort()) {
          yield* Console.log(s);
        }
      }),
    );
  }),
);

const stagesCommand = Command.make(
  "stages",
  { stack: stackArg, main, envFile, stage, profile, local: localFlag },
  Effect.fnUntraced(function* ({ stack: stackName, ...rest }) {
    yield* withStateService(rest, (state) =>
      Effect.gen(function* () {
        const stages = yield* state.listStages(stackName);
        if (stages.length === 0) {
          yield* Console.log(`(no stages in ${stackName})`);
          return;
        }
        for (const s of [...stages].sort()) {
          yield* Console.log(s);
        }
      }),
    );
  }),
);

const resourcesCommand = Command.make(
  "resources",
  {
    stack: stackArg,
    stageName: Argument.string("stage").pipe(
      Argument.withDescription("Stage to list resources from"),
    ),
    main,
    envFile,
    stage,
    profile,
    local: localFlag,
  },
  Effect.fnUntraced(function* ({ stack: stackName, stageName, ...rest }) {
    yield* withStateService(rest, (state) =>
      Effect.gen(function* () {
        const fqns = yield* state.list({ stack: stackName, stage: stageName });
        if (fqns.length === 0) {
          yield* Console.log(`(no resources in ${stackName}/${stageName})`);
          return;
        }
        for (const f of [...fqns].sort()) {
          yield* Console.log(f);
        }
      }),
    );
  }),
);

const getCommand = Command.make(
  "get",
  {
    stack: stackArg,
    stageName: Argument.string("stage").pipe(
      Argument.withDescription("Stage the resource lives in"),
    ),
    fqn: fqnArg,
    main,
    envFile,
    stage,
    profile,
    local: localFlag,
  },
  Effect.fnUntraced(function* ({ stack: stackName, stageName, fqn, ...rest }) {
    yield* withStateService(rest, (state) =>
      Effect.gen(function* () {
        const value = yield* state.get({
          stack: stackName,
          stage: stageName,
          fqn,
        });
        if (value === undefined) {
          yield* Console.log(
            `(not found: ${stackName}/${stageName}/${fqn})`,
          );
          return;
        }
        // encodeState produces a JSON-friendly view: redacted secrets
        // are unwrapped into `{ __redacted__: ... }`, Resources are
        // flattened, etc. Same shape the store persists.
        yield* Console.log(JSON.stringify(encodeState(value), null, 2));
      }),
    );
  }),
);

const treeCommand = Command.make(
  "tree",
  { main, envFile, stage, profile, local: localFlag },
  Effect.fnUntraced(function* (args) {
    yield* withStateService(args, (state) =>
      Effect.gen(function* () {
        const stacks = [...(yield* state.listStacks())].sort();
        if (stacks.length === 0) {
          yield* Console.log("(empty state store)");
          return;
        }
        for (const stk of stacks) {
          yield* Console.log(stk);
          const stages = [...(yield* state.listStages(stk))].sort();
          for (let i = 0; i < stages.length; i++) {
            const stg = stages[i]!;
            const stageBranch = i === stages.length - 1 ? "└─" : "├─";
            yield* Console.log(`${stageBranch} ${stg}`);
            const indent = i === stages.length - 1 ? "   " : "│  ";
            const fqns = [
              ...(yield* state.list({ stack: stk, stage: stg })),
            ].sort();
            for (let j = 0; j < fqns.length; j++) {
              const fqn = fqns[j]!;
              const leaf = j === fqns.length - 1 ? "└─" : "├─";
              yield* Console.log(`${indent}${leaf} ${fqn}`);
            }
          }
        }
      }),
    );
  }),
);

export const stateCommand = Command.make("state", {}).pipe(
  Command.withSubcommands([
    stacksCommand,
    stagesCommand,
    resourcesCommand,
    getCommand,
    treeCommand,
  ]),
);
