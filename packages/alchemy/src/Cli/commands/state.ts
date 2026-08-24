import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Argument from "effect/unstable/cli/Argument";
import { Command, Flag } from "effect/unstable/cli";
import { StateControl } from "../../AlchemyControl/StateControl.ts";
import type { StateSource } from "../../AlchemyControl/State.ts";
import * as CliKit from "../../Cli/CliKit/index.ts";
import {
  stateExplorerScreen,
  type StateExplorerSource,
} from "../views/StateExplorer.tsx";
import {
  config,
  envFile,
  failWithHelp,
  instrumentCommand,
  profile,
  UserInputError,
} from "./_shared.ts";

const backend = Flag.choice("backend", ["configured", "local"] as const).pipe(
  Flag.withDescription("State backend (default: configured)"),
  Flag.withDefault("configured" as const),
);
const pathArgument = Argument.string("path").pipe(
  Argument.withDescription("State path (stack/stage/namespace/resource)"),
  Argument.optional,
);
const requiredPathArgument = Argument.string("path").pipe(
  Argument.withDescription("State path (stack/stage/namespace/resource)"),
);
const recursive = Flag.boolean("recursive").pipe(
  Flag.withAlias("r"),
  Flag.withDescription("Operate recursively on directories"),
  Flag.withDefault(false),
);

type StateArgs = {
  readonly main: string;
  readonly envFile: Option.Option<string>;
  readonly profile: string | undefined;
  readonly backend: "configured" | "local";
};

const source = (args: StateArgs): StateSource =>
  args.backend === "local"
    ? { backend: "local" }
    : {
        backend: "configured",
        entrypoint: args.main,
        profile: args.profile,
        envFile: Option.getOrUndefined(args.envFile),
      };

const normalizedPath = (path: string | undefined) => {
  const parts = (path ?? "")
    .split("/")
    .filter((part) => part !== "" && part !== ".");
  return parts.includes("..")
    ? Effect.fail(
        new UserInputError({ message: `invalid state path: ${path ?? "/"}` }),
      )
    : Effect.succeed(parts.join("/"));
};

const listCommand = Command.make(
  "list",
  { path: pathArgument, recursive, main: config, envFile, profile, backend },
  instrumentCommand("state.list")(
    Effect.fn(function* ({ path, recursive, ...args }) {
      const state = yield* StateControl;
      const items = yield* state.list({
        source: source(args),
        path: yield* normalizedPath(Option.getOrUndefined(path)),
        recursive,
      });
      yield* Console.log([...items].sort().join("\n"));
    }),
  ),
).pipe(
  Command.withAlias("ls"),
  Command.withDescription("List a state-store directory"),
);

const readCommand = Command.make(
  "read",
  { path: pathArgument, recursive, main: config, envFile, profile, backend },
  instrumentCommand("state.read")(
    Effect.fn(function* ({ path, recursive, ...args }) {
      const state = yield* StateControl;
      const requested = yield* normalizedPath(Option.getOrUndefined(path));
      const entries = yield* state.read({
        source: source(args),
        path: requested,
        recursive,
      });
      yield* Console.log(
        JSON.stringify(
          entries.length === 1
            ? entries[0]!.value
            : Object.fromEntries(
                entries.map((entry) => [entry.path, entry.value]),
              ),
          null,
          2,
        ),
      );
    }),
  ),
).pipe(
  Command.withAlias("cat"),
  Command.withDescription("Read a state-store file or directory"),
);

const deleteCommand = Command.make(
  "delete",
  {
    path: requiredPathArgument,
    recursive,
    main: config,
    envFile,
    profile,
    backend,
  },
  instrumentCommand("state.delete")(
    Effect.fn(function* ({ path, recursive, ...args }) {
      const requested = yield* normalizedPath(path);
      if (requested === "") {
        return yield* Effect.fail(
          new UserInputError({ message: "cannot delete the state root" }),
        );
      }
      yield* (yield* StateControl).delete({
        source: source(args),
        path: requested,
        recursive,
      });
      yield* CliKit.accessors.output.success(`Deleted state at ${requested}`);
    }),
  ),
).pipe(
  Command.withAlias("rm"),
  Command.withDescription(
    "Delete state records without deleting cloud resources",
  ),
);

const stateExplorer = (args: StateArgs) =>
  Effect.gen(function* () {
    const state = yield* StateControl;
    const selected = source(args);
    const cli = yield* CliKit.CliKit;
    const { backend } = yield* state.info({ source: selected });
    const explorer: StateExplorerSource = {
      backend,
      listStacks: state
        .list({ source: selected })
        .pipe(Effect.map((paths) => paths.map((path) => path.slice(0, -1)))),
      listStages: (stack) =>
        state
          .list({ source: selected, path: stack })
          .pipe(
            Effect.map((paths) =>
              paths.map((path) => path.slice(stack.length + 1, -1)),
            ),
          ),
      listResources: (stack, stage) =>
        state
          .list({
            source: selected,
            path: `${stack}/${stage}`,
            recursive: true,
          })
          .pipe(
            Effect.map((paths) =>
              paths
                .filter((path) => path !== `${stack}/${stage}/output`)
                .map((path) => path.slice(`${stack}/${stage}/`.length)),
            ),
          ),
      readFile: (file) =>
        state
          .read({
            source: selected,
            path: `${file.stack}/${file.stage}/${file.kind === "output" ? "output" : file.fqn}`,
          })
          .pipe(Effect.map((entries) => entries[0]?.value)),
      deleteNodes: (nodes) =>
        Effect.forEach(
          nodes.filter(
            (node, index) =>
              !nodes.some(
                (parent, parentIndex) =>
                  parentIndex !== index &&
                  ["stack", "stage", "namespace"].includes(parent.kind) &&
                  node.path.startsWith(`${parent.path}/`),
              ),
          ),
          (node) =>
            node.kind === "output"
              ? Effect.void
              : state
                  .delete({
                    source: selected,
                    path: node.path,
                    recursive: true,
                  })
                  .pipe(Effect.asVoid),
          { concurrency: 32, discard: true },
        ),
    };
    const screen = stateExplorerScreen(explorer);
    yield* cli
      .route({
        initialPath: "/state",
        routes: [
          {
            path: "/state",
            render: ({ exit, cancel }) =>
              screen.render({ submit: exit, cancel }),
          },
        ],
      })
      .pipe(CliKit.Application.alternate)
      .pipe(Effect.catchTag("TerminalCancelled", () => Effect.void));
  });

export const stateCommand = Command.make(
  "state",
  { main: config, envFile, profile, backend },
  instrumentCommand("state")(
    Effect.fn(function* (args) {
      if (!(yield* CliKit.CliKit).terminal.input) {
        return yield* failWithHelp(["alchemy", "state"]);
      }
      yield* stateExplorer(args);
    }),
  ),
).pipe(
  Command.withDescription("Inspect and manage deployment state"),
  Command.withSubcommands([listCommand, readCommand, deleteCommand]),
);
