import * as ConfigProvider from "effect/ConfigProvider";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";
import * as Argument from "effect/unstable/cli/Argument";
import { Command, Flag } from "effect/unstable/cli";

import { AuthProviders } from "../../Auth/AuthProvider.ts";
import { withProfileOverride } from "../../Auth/Profile.ts";
import * as CliKit from "../../Cli/CliKit/index.ts";
import { Stage } from "../../Stage.ts";
import * as State from "../../State/index.ts";
import { encodeState } from "../../State/StateEncoding.ts";
import { loadConfigProvider } from "../../Util/ConfigProvider.ts";
import { fileLogger } from "../../Util/FileLogger.ts";
import {
  stateExplorerScreen,
  type StateBrowserNode,
  type StateExplorerSource,
  type StateFileRef,
} from "../views/StateExplorer.tsx";

import {
  config,
  envFile,
  failWithHelp,
  importStack,
  instrumentCommand,
  profile,
  UserInputError,
} from "./_shared.ts";

const backend = Flag.choice("backend", ["configured", "local"] as const).pipe(
  Flag.withDescription("State backend (default: configured)"),
  Flag.withDefault("configured" as const),
);

const pathArgument = Argument.string("path").pipe(
  Argument.withDescription("State path (stack/stage/namespace/resource.json)"),
  Argument.optional,
);

const requiredPathArgument = Argument.string("path").pipe(
  Argument.withDescription("State path (stack/stage/namespace/resource.json)"),
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

const withStateService = <A, E>(
  args: StateArgs,
  body: (state: State.StateService) => Effect.Effect<A, E, never>,
) =>
  Effect.gen(function* () {
    if (args.backend === "local") {
      return yield* Effect.gen(function* () {
        return yield* body(yield* yield* State.State);
      }).pipe(Effect.provide(State.localState()));
    }

    const stackEffect = yield* importStack(args.main);
    const services = Layer.mergeAll(
      Layer.succeed(AuthProviders, {}),
      ConfigProvider.layer(
        withProfileOverride(
          yield* loadConfigProvider(args.envFile),
          args.profile,
        ),
      ),
      Logger.layer([fileLogger("out")], { mergeWithExisting: true }),
      Layer.succeed(Stage, "placeholder"),
    );

    return yield* Effect.gen(function* () {
      const stack = yield* stackEffect;
      return yield* Effect.gen(function* () {
        return yield* body(yield* yield* State.State);
      }).pipe(Effect.provide(stack.services));
    }).pipe(Effect.provide(services));
  });

const pathParts = (path: string | undefined): ReadonlyArray<string> =>
  (path ?? "").split("/").filter((part) => part !== "" && part !== ".");

const invalidPath = (path: string) =>
  Effect.fail(new UserInputError({ message: `invalid state path: ${path}` }));

type StateFile =
  | {
      readonly kind: "resource";
      readonly path: string;
      readonly stack: string;
      readonly stage: string;
      readonly fqn: string;
    }
  | {
      readonly kind: "output";
      readonly path: string;
      readonly stack: string;
      readonly stage: string;
    };

const stageFiles = Effect.fn(function* (
  state: State.StateService,
  stack: string,
  stage: string,
) {
  const fqns = yield* state.list({ stack, stage });
  return [
    ...fqns.map(
      (fqn): StateFile => ({
        kind: "resource",
        path: `${stack}/${stage}/${fqn}.json`,
        stack,
        stage,
        fqn,
      }),
    ),
    {
      kind: "output",
      path: `${stack}/${stage}/output.json`,
      stack,
      stage,
    } as const,
  ];
});

const allFiles = Effect.fn(function* (state: State.StateService) {
  const files: StateFile[] = [];
  for (const stack of yield* state.listStacks()) {
    for (const stage of yield* state.listStages(stack)) {
      files.push(...(yield* stageFiles(state, stack, stage)));
    }
  }
  return files;
});

const filesAt = Effect.fn(function* (
  state: State.StateService,
  parts: ReadonlyArray<string>,
) {
  const path = parts.join("/");
  if (parts.length === 0) {
    return { directory: true as const, files: yield* allFiles(state) };
  }
  if (parts.length === 1) {
    const stack = parts[0]!;
    if (!(yield* state.listStacks()).includes(stack)) {
      return yield* invalidPath(path);
    }
    const files: StateFile[] = [];
    for (const stage of yield* state.listStages(stack)) {
      files.push(...(yield* stageFiles(state, stack, stage)));
    }
    return { directory: true as const, files };
  }
  if (parts.length === 2) {
    const [stack, stage] = parts as [string, string];
    if (!(yield* state.listStages(stack)).includes(stage)) {
      return yield* invalidPath(path);
    }
    return {
      directory: true as const,
      files: yield* stageFiles(state, stack, stage),
    };
  }
  const files = yield* stageFiles(state, parts[0]!, parts[1]!);
  const exact = files.find((file) => file.path === path);
  if (exact !== undefined) return { directory: false as const, files: [exact] };
  const prefix = path === "" ? "" : `${path}/`;
  const descendants = files.filter((file) => file.path.startsWith(prefix));
  if (descendants.length === 0) return yield* invalidPath(path);
  return { directory: true as const, files: descendants };
});

const listPaths = Effect.fn(function* (
  state: State.StateService,
  parts: ReadonlyArray<string>,
  recurse: boolean,
) {
  const path = parts.join("/");
  if (parts.length === 0 && !recurse) {
    return (yield* state.listStacks()).map((stack) => `${stack}/`);
  }
  const { directory, files } = yield* filesAt(state, parts);
  if (!directory) return [path];
  const prefix = path === "" ? "" : `${path}/`;
  if (recurse) return files.map((file) => file.path);
  return [
    ...new Set(
      files.map((file) => {
        const rest = file.path.slice(prefix.length);
        const child = rest.split("/")[0]!;
        return rest.includes("/") ? `${prefix}${child}/` : file.path;
      }),
    ),
  ];
});

const listCommand = Command.make(
  "list",
  {
    path: pathArgument,
    recursive,
    main: config,
    envFile,
    profile,
    backend,
  },
  instrumentCommand("state.list")(
    Effect.fn(function* ({ path, recursive, ...rest }) {
      const parts = pathParts(Option.getOrUndefined(path));
      if (parts.includes("..")) return yield* invalidPath(parts.join("/"));
      yield* withStateService(rest, (state) =>
        listPaths(state, parts, recursive).pipe(
          Effect.flatMap((items) => Console.log([...items].sort().join("\n"))),
        ),
      );
    }),
  ),
).pipe(
  Command.withAlias("ls"),
  Command.withDescription("List a state-store directory"),
);

const readCommand = Command.make(
  "read",
  {
    path: pathArgument,
    recursive,
    main: config,
    envFile,
    profile,
    backend,
  },
  instrumentCommand("state.read")(
    Effect.fn(function* ({ path, recursive, ...rest }) {
      const requestedPath = Option.getOrUndefined(path);
      const parts = pathParts(requestedPath);
      if (parts.includes("..")) return yield* invalidPath(requestedPath ?? "/");
      yield* withStateService(rest, (state) =>
        Effect.gen(function* () {
          const target = yield* filesAt(state, parts);
          if (target.directory && !recursive) {
            return yield* Effect.fail(
              new UserInputError({
                message: `${requestedPath ?? "/"} is a directory; use --recursive`,
              }),
            );
          }
          const values = yield* Effect.forEach(target.files, (file) =>
            (file.kind === "output"
              ? state.getOutput(file)
              : state.get(file)
            ).pipe(
              Effect.map(
                (value) => [file.path, encodeState(value) ?? null] as const,
              ),
            ),
          );
          yield* Console.log(
            JSON.stringify(
              values.length === 1 ? values[0]![1] : Object.fromEntries(values),
              null,
              2,
            ),
          );
        }),
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
    Effect.fn(function* ({ path, recursive, ...rest }) {
      const parts = pathParts(path);
      if (parts.length === 0 || parts.includes(".."))
        return yield* invalidPath(path);
      yield* withStateService(rest, (state) =>
        Effect.gen(function* () {
          const target = yield* filesAt(state, parts);
          if (target.directory && !recursive) {
            return yield* Effect.fail(
              new UserInputError({
                message: `${path} is a directory; use --recursive`,
              }),
            );
          }
          if (parts.length === 1) {
            yield* state.deleteStack({ stack: parts[0]! });
          } else if (parts.length === 2) {
            yield* state.deleteStack({ stack: parts[0]!, stage: parts[1]! });
          } else {
            const resources = target.files.filter(
              (file) => file.kind === "resource",
            );
            if (resources.length === 0) {
              return yield* Effect.fail(
                new UserInputError({
                  message: "output.json cannot be deleted independently",
                }),
              );
            }
            yield* Effect.forEach(resources, (file) => state.delete(file), {
              concurrency: 32,
            });
          }
          yield* (yield* CliKit.CliKit).output.success(
            `Deleted state at ${path}`,
          );
        }),
      );
    }),
  ),
).pipe(
  Command.withAlias("rm"),
  Command.withDescription(
    "Delete state records without deleting cloud resources",
  ),
);

const stateExplorer = (args: StateArgs) =>
  withStateService(args, (state) =>
    Effect.gen(function* () {
      const cli = yield* CliKit.CliKit;
      const source: StateExplorerSource = {
        backend: state.id,
        listStacks: () => Effect.runPromise(state.listStacks()),
        listStages: (stack) => Effect.runPromise(state.listStages(stack)),
        listResources: (stack, stage) =>
          Effect.runPromise(state.list({ stack, stage })),
        readFile: (file) =>
          Effect.runPromise(
            file.kind === "output" ? state.getOutput(file) : state.get(file),
          ).then(encodeState),
        deleteNodes: (nodes) =>
          Effect.runPromise(
            Effect.forEach(
              // Drop nodes covered by a marked ancestor so a stack/stage
              // delete isn't raced by per-resource deletes beneath it.
              nodes.filter(
                (node, index) =>
                  !nodes.some(
                    (parent, parentIndex) =>
                      parentIndex !== index &&
                      (parent.kind === "stack" ||
                        parent.kind === "stage" ||
                        parent.kind === "namespace") &&
                      node.path.startsWith(`${parent.path}/`),
                  ),
              ),
              (node) => {
                if (node.kind === "stack") {
                  return state.deleteStack({ stack: node.stack });
                }
                if (node.kind === "stage") {
                  return state.deleteStack({
                    stack: node.stack,
                    stage: node.stage,
                  });
                }
                if (node.kind === "resource") return state.delete(node.file);
                // The explorer blocks deleting output.json directly — it is
                // removed with its stage.
                if (node.kind === "output") return Effect.void;
                const resources: Array<
                  StateFileRef & { readonly kind: "resource" }
                > = [];
                const collect = (children: ReadonlyArray<StateBrowserNode>) => {
                  for (const child of children) {
                    if (child.kind === "resource") resources.push(child.file);
                    else if (child.kind === "namespace")
                      collect(child.children);
                  }
                };
                collect(node.children);
                return Effect.forEach(
                  resources,
                  (resource) => state.delete(resource),
                  { concurrency: 32, discard: true },
                );
              },
              { concurrency: 32, discard: true },
            ),
          ),
      };
      yield* cli
        .application(cli.prompt.custom(stateExplorerScreen(source)))
        .pipe(CliKit.Application.alternate)
        .pipe(Effect.catchTag("TerminalCancelled", () => Effect.void));
    }),
  );

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
