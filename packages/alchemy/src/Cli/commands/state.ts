import { Command, Flag } from "effect/cli";
import * as Argument from "effect/cli/Argument";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as AlchemistState from "../../Alchemist/routes/state.ts";
import type { StateSource } from "../../Alchemist/routes/state.ts";
import * as CliKit from "../../Cli/CliKit/index.ts";
import * as State from "../../State/index.ts";
import {
  stateExplorerScreen,
  type StateExplorerSource,
} from "../components/view/StateExplorer.tsx";
import { formatLocalTimestamp } from "../Format.ts";
import { confirmOrDecline } from "./confirm.ts";
import { failWithHelp, UserInputError } from "./errors.ts";
import { envFile, parseSince, profile, yes } from "./flags.ts";
import { instrumentCommand } from "./instrument.ts";

const backend = Flag.String("backend").pipe(
  Flag.withDescription(
    "State backend: configured (default), local, or a provider's state store (e.g. aws, cloudflare)",
  ),
  Flag.withDefault("configured"),
);
const config = Flag.File("config").pipe(
  Flag.withDescription("Alchemy entrypoint file (default: alchemy.run.ts)"),
  Flag.withAlias("c"),
  Flag.withDefault("alchemy.run.ts"),
);
const pathArgument = Argument.String("path").pipe(
  Argument.withDescription("State path (stack/stage/namespace/resource)"),
  Argument.optional,
);
const requiredPathArgument = Argument.String("path").pipe(
  Argument.withDescription("State path (stack/stage/namespace/resource)"),
);
const recursive = Flag.Boolean("recursive").pipe(
  Flag.withAlias("r"),
  Flag.withDescription("Operate recursively on directories"),
  Flag.withDefault(false),
);

type StateArgs = {
  readonly main: string;
  readonly envFile: Option.Option<string>;
  readonly profile: string | undefined;
  readonly backend: string;
};

const source = (args: StateArgs): StateSource =>
  args.backend === "local"
    ? { backend: "local" }
    : args.backend === "configured"
      ? {
          backend: "configured",
          entrypoint: args.main,
          profile: args.profile,
          envFile: Option.getOrUndefined(args.envFile),
        }
      : {
          backend: args.backend,
          profile: args.profile,
          envFile: Option.getOrUndefined(args.envFile),
        };

const normalizedPath = (path: string | undefined) => {
  const parts = (path ?? "").split("/").filter((part) => part !== "" && part !== ".");
  return parts.includes("..")
    ? Effect.fail(new UserInputError({ message: `invalid state path: ${path ?? "/"}` }))
    : Effect.succeed(parts.join("/"));
};

const provideStore =
  (store: State.StateService) =>
  <A, E>(operation: Effect.Effect<A, E, State.State>) =>
    operation.pipe(Effect.provideService(State.State, Effect.succeed(store)));

/** Run a state tree operation against a resolved store, mapping a bad path
 * to a single-line user error instead of a cause dump. */
const usingStore =
  (store: State.StateService) =>
  <A>(operation: Effect.Effect<A, State.InvalidStatePath | State.StateStoreError, State.State>) =>
    provideStore(store)(operation).pipe(
      Effect.catchTag("InvalidStatePath", (error) =>
        Effect.fail(new UserInputError({ message: `${error.path}: ${error.reason}` })),
      ),
    );

const listCommand = Command.make(
  "list",
  { path: pathArgument, recursive, main: config, envFile, profile, backend },
  instrumentCommand("state.list")(
    Effect.fn(function* ({ path, recursive, ...args }) {
      const store = yield* AlchemistState.store(source(args));
      const items = yield* usingStore(store)(
        State.listState({
          path: yield* path.pipe(Option.getOrUndefined, normalizedPath),
          recursive,
        }),
      );
      yield* Console.log([...items].sort().join("\n"));
    }),
  ),
).pipe(Command.withAlias("ls"), Command.withDescription("List a state-store directory"));

const readCommand = Command.make(
  "read",
  { path: pathArgument, recursive, main: config, envFile, profile, backend },
  instrumentCommand("state.read")(
    Effect.fn(function* ({ path, recursive, ...args }) {
      const store = yield* AlchemistState.store(source(args));
      const requested = yield* path.pipe(Option.getOrUndefined, normalizedPath);
      const entries = yield* usingStore(store)(State.readState({ path: requested, recursive }));
      yield* Console.log(
        JSON.stringify(
          entries.length === 1
            ? entries[0]!.value
            : Object.fromEntries(entries.map((entry) => [entry.path, entry.value])),
          null,
          2,
        ),
      );
    }),
  ),
).pipe(Command.withAlias("cat"), Command.withDescription("Read a state-store file or directory"));

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
        return yield* new UserInputError({ message: "cannot delete the state root" });
      }
      const store = yield* AlchemistState.store(source(args));
      yield* usingStore(store)(State.deleteState({ path: requested, recursive }));
      yield* CliKit.accessors.output.success(`Deleted state at ${requested}`);
    }),
  ),
).pipe(
  Command.withAlias("rm"),
  Command.withDescription("Delete state records without deleting cloud resources"),
);

const stateExplorer = (args: StateArgs) =>
  Effect.gen(function* () {
    const cli = yield* CliKit.CliKit;
    const store = yield* AlchemistState.store(source(args));
    const on = provideStore(store);
    const explorer: StateExplorerSource = {
      backend: store.id,
      listStacks: on(State.listState({})).pipe(
        Effect.map((paths) => paths.map((path) => path.slice(0, -1))),
      ),
      listStages: (stack) =>
        on(State.listState({ path: stack })).pipe(
          Effect.map((paths) => paths.map((path) => path.slice(stack.length + 1, -1))),
        ),
      listResources: (stack, stage) =>
        on(State.listState({ path: `${stack}/${stage}`, recursive: true })).pipe(
          Effect.map((paths) =>
            paths
              .filter((path) => path !== `${stack}/${stage}/output`)
              .map((path) => path.slice(`${stack}/${stage}/`.length)),
          ),
        ),
      readFile: (file) =>
        on(
          State.readState({
            path: `${file.stack}/${file.stage}/${file.kind === "output" ? "output" : file.fqn}`,
          }),
        ).pipe(Effect.map((entries) => entries[0]?.value)),
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
              : on(State.deleteState({ path: node.path, recursive: true })).pipe(Effect.asVoid),
          { concurrency: 32, discard: true },
        ),
    };
    // Captured here so the explorer's forked fibers run with the command's
    // ambient services (tracing, terminal) rather than the default runtime.
    const services = yield* Effect.context<never>();
    yield* cli.application(cli.prompt.custom(stateExplorerScreen(explorer, services))).pipe(
      CliKit.Application.alternate,
      Effect.catchTag("TerminalCancelled", () => Effect.void),
    );
  });

const nukeCommand = Command.make(
  "nuke",
  { main: config, envFile, profile, backend, yes },
  instrumentCommand("state.unsafe.nuke")(
    Effect.fn(function* ({ yes, ...args }) {
      const store = yield* AlchemistState.store(source(args));
      const stacks = [...(yield* store.listStacks())].sort();
      if (stacks.length === 0) {
        yield* CliKit.accessors.output.info("Nothing to clear.");
        return;
      }
      yield* Console.log(stacks.map((stack) => `• ${stack}`).join("\n"));
      yield* confirmOrDecline({
        yes,
        message: `Permanently delete ALL ${stacks.length} stacks from the state store? This cannot be undone. Cloud resources will remain.`,
      });
      yield* Effect.forEach(
        stacks,
        (stack) =>
          store
            .deleteStack({ stack })
            .pipe(Effect.andThen(CliKit.accessors.output.success(`Cleared ${stack}`))),
        { concurrency: 32, discard: true },
      );
    }),
  ),
).pipe(
  Command.withDescription("Delete all stacks, stages, and outputs from the state store"),
  Command.unlisted,
);

/** Lifecycle commands address a plugin's state store, never the configured one. */
const lifecycleBackend = Flag.String("backend").pipe(
  Flag.withDescription("State store to act on (e.g. cloudflare)"),
);

const lifecycleTarget = (args: {
  readonly backend: string;
  readonly profile: string | undefined;
  readonly envFile: Option.Option<string>;
}) => ({
  backend: args.backend,
  profile: args.profile,
  envFile: Option.getOrUndefined(args.envFile),
});

const bootstrapCommand = Command.make(
  "bootstrap",
  {
    envFile,
    profile,
    backend: lifecycleBackend,
    force: Flag.Boolean("force").pipe(
      Flag.withDescription("Redeploy an existing state store instead of adopting it"),
      Flag.withDefault(false),
    ),
  },
  instrumentCommand("state.bootstrap")(
    Effect.fn(function* ({ force, ...args }) {
      const result = yield* AlchemistState.bootstrap({ ...lifecycleTarget(args), force });
      yield* CliKit.accessors.output.success(result.summary);
    }),
  ),
).pipe(Command.withDescription("Provision (or adopt) a state store"));

const teardownCommand = Command.make(
  "teardown",
  { envFile, profile, backend: lifecycleBackend, yes },
  instrumentCommand("state.teardown")(
    Effect.fn(function* ({ yes: approved, ...args }) {
      yield* confirmOrDecline({
        yes: approved,
        message: `Tear down the ${args.backend} state store and its backing resources?`,
        confirmLabel: "Destroy",
        cancelLabel: "Cancel",
      });
      const result = yield* AlchemistState.teardown(lifecycleTarget(args));
      yield* CliKit.accessors.output.success(
        result.deleted.length === 0 ? "Nothing to delete" : `Deleted ${result.deleted.join(", ")}`,
      );
    }),
  ),
).pipe(Command.withDescription("Delete a state store and its backing resources"), Command.unlisted);

const logsCommand = Command.make(
  "logs",
  {
    envFile,
    profile,
    backend: lifecycleBackend,
    tail: Flag.Boolean("tail").pipe(
      Flag.withAlias("t"),
      Flag.withDescription("Stream logs as they happen instead of fetching past entries"),
      Flag.withDefault(false),
    ),
    limit: Flag.Int("limit").pipe(
      Flag.withDescription("Number of log entries to fetch (ignored with --tail)"),
      Flag.withDefault(100),
    ),
    since: Flag.String("since").pipe(
      Flag.withDescription("Fetch logs since this time (e.g. '1h', '30m', '2024-01-01T00:00:00Z')"),
      Flag.optional,
      Flag.map(Option.getOrUndefined),
    ),
  },
  instrumentCommand("state.logs")(
    Effect.fn(function* ({ tail, limit, since, ...args }) {
      const target = lifecycleTarget(args);
      const format = (entry: {
        timestamp: Date;
        message: string;
        resource: { logicalId: string };
      }) =>
        `${formatLocalTimestamp(entry.timestamp)} [${entry.resource.logicalId}] ${entry.message}`;
      if (tail) {
        yield* CliKit.accessors.output.info(`Tailing the ${args.backend} state store...`);
        yield* AlchemistState.tailLogs(target).pipe(
          Stream.runForEach((entry) => Console.log(format(entry))),
        );
        return;
      }
      const entries = yield* AlchemistState.logs({
        ...target,
        limit,
        since: since ? yield* parseSince(since) : undefined,
      });
      if (entries.length === 0) {
        yield* Console.log(`(no log entries for the ${args.backend} state store)`);
        return;
      }
      for (const entry of entries) yield* Console.log(format(entry));
    }),
  ),
).pipe(Command.withDescription("Fetch or stream a state store's own logs"));

const unsafeCommand = Command.make("unsafe", {}).pipe(
  Command.withDescription("Destructive state operations"),
  Command.withSubcommands([nukeCommand]),
  Command.unlisted,
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
  Command.withSubcommands([
    listCommand,
    readCommand,
    deleteCommand,
    bootstrapCommand,
    teardownCommand,
    logsCommand,
    unsafeCommand,
  ]),
);
