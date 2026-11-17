import * as Arr from "effect/Array";
import { CliError, Command, Flag, Param } from "effect/cli";
import * as Argument from "effect/cli/Argument";
import * as Console from "effect/Console";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Record from "effect/Record";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as Alchemist from "../../Alchemist/index.ts";
import type * as Contributions from "../../Contributions.ts";
import * as Interaction from "../../Interaction.ts";
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
/** The store options `alchemy state` was given, shared with its subcommands. */
class StoreOptions extends Context.Service<
  StoreOptions,
  {
    /** The store options given, by option key. */
    readonly given: Contributions.StateStoreOptions;
    /** Options each backend can't take from the CLI, its flag left out. */
    readonly ignored: Readonly<Record<string, ReadonlyArray<string>>>;
  }
>()("alchemy/Cli/state/StoreOptions") {}

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

const source = Effect.fn(function* (args: StateArgs) {
  if (args.backend !== "local" && args.backend !== "configured") {
    return yield* lifecycleSource(args);
  }
  const { given } = yield* StoreOptions;
  if (Record.some(given, Predicate.isNotUndefined)) {
    return yield* new UserInputError({
      message: "State store options need --backend with a provider's state store.",
    });
  }
  const source: Alchemist.State.StateSource =
    args.backend === "local"
      ? { type: "local" }
      : {
          type: "configured",
          entrypoint: args.main,
          profile: args.profile,
          envFile: Option.getOrUndefined(args.envFile),
        };
  return source;
});

/** Lifecycle commands act on a provider's state store. */
const lifecycleBackend = Flag.String("backend").pipe(
  Flag.withDescription("Provider state store to act on (e.g. aws, cloudflare)"),
);

const lifecycleSource = Effect.fn(function* (
  args: Pick<StateArgs, "envFile" | "profile" | "backend">,
) {
  const { given, ignored } = yield* StoreOptions;
  const unusable = (ignored[args.backend] ?? []).find((option) => given[option] !== undefined);
  if (unusable !== undefined) {
    return yield* new UserInputError({
      message: `The '${args.backend}' state store's flag for '${unusable}' was left out, as warned above, so the CLI can't set it.`,
    });
  }
  const source: Alchemist.State.ProviderSource = {
    ...given,
    type: "provider",
    backend: args.backend,
    profile: args.profile,
    envFile: Option.getOrUndefined(args.envFile),
  };
  return source;
});

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
      const store = yield* source(args).pipe(Effect.flatMap(Alchemist.State.store));
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
      const store = yield* source(args).pipe(Effect.flatMap(Alchemist.State.store));
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
      const store = yield* source(args).pipe(Effect.flatMap(Alchemist.State.store));
      yield* usingStore(store)(State.deleteState({ path: requested, recursive }));
      yield* Interaction.success(`Deleted state at ${requested}`);
    }),
  ),
).pipe(
  Command.withAlias("rm"),
  Command.withDescription("Delete state records without deleting cloud resources"),
);

const stateExplorer = (args: StateArgs) =>
  Effect.gen(function* () {
    const cli = yield* Interaction.Interaction;
    const store = yield* source(args).pipe(Effect.flatMap(Alchemist.State.store));
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
    yield* cli
      .session(cli.prompt.screen(stateExplorerScreen(explorer, services)), { alternate: true })
      .pipe(Effect.catchTag("TerminalCancelled", () => Effect.void));
  });

const nukeCommand = Command.make(
  "nuke",
  { main: config, envFile, profile, backend, yes },
  instrumentCommand("state.unsafe.nuke")(
    Effect.fn(function* ({ yes, ...args }) {
      const store = yield* source(args).pipe(Effect.flatMap(Alchemist.State.store));
      const stacks = [...(yield* store.listStacks())].sort();
      if (stacks.length === 0) {
        yield* Interaction.info("Nothing to clear.");
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
            .pipe(Effect.andThen(Interaction.success(`Cleared ${stack}`))),
        { concurrency: 32, discard: true },
      );
    }),
  ),
).pipe(
  Command.withDescription("Delete all stacks, stages, and outputs from the state store"),
  Command.unlisted,
);

const bootstrapCommand = Command.make(
  "bootstrap",
  {
    main: config,
    envFile,
    profile,
    backend: Flag.String("backend").pipe(
      Flag.withDescription(
        "Provider state store to act on (e.g. aws, cloudflare); defaults to the one the config sets",
      ),
      Flag.optional,
      Flag.map(Option.getOrUndefined),
    ),
    force: Flag.Boolean("force").pipe(
      Flag.withDescription(
        "Redeploy an existing state store instead of adopting it (with --backend)",
      ),
      Flag.withDefault(false),
    ),
  },
  instrumentCommand("state.bootstrap")(
    Effect.fn(function* ({ force, main, backend, ...args }) {
      if (backend === undefined) {
        const { given } = yield* StoreOptions;
        if (force || Record.some(given, Predicate.isNotUndefined)) {
          return yield* new UserInputError({
            message: "--force and state store options need --backend.",
          });
        }
        const { version } = yield* Alchemist.State.bootstrapConfigured({
          type: "configured",
          entrypoint: main,
          profile: args.profile,
          envFile: Option.getOrUndefined(args.envFile),
        });
        yield* Interaction.success(`State store configured in '${main}' is ready (v${version})`);
        return;
      }
      const target = yield* lifecycleSource({ ...args, backend });
      const result = yield* Alchemist.State.bootstrap({ ...target, force });
      yield* Interaction.success(
        `State store '${result.store}' ${result.status} (${Object.values(result.location).join(", ")})`,
      );
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
      const result = yield* lifecycleSource(args).pipe(Effect.flatMap(Alchemist.State.teardown));
      yield* Interaction.success(
        result.deleted.length === 0 ? "Nothing to delete" : `Deleted ${result.deleted.join(", ")}`,
      );
    }),
  ),
).pipe(Command.withDescription("Delete a state store and its backing resources"), Command.unlisted);

const migrateCommand = Command.make(
  "migrate",
  {
    main: config,
    envFile,
    profile,
    backend,
    stack: Flag.String("stack").pipe(
      Flag.withDescription("Only migrate this stack's stages"),
      Flag.optional,
      Flag.map(Option.getOrUndefined),
    ),
    stage: Flag.String("stage").pipe(
      Flag.withDescription("Only migrate stages of this name"),
      Flag.optional,
      Flag.map(Option.getOrUndefined),
    ),
    rollback: Flag.Boolean("rollback").pipe(
      Flag.withDescription("Move stages back to the state store this one replaces"),
      Flag.withDefault(false),
    ),
  },
  instrumentCommand("state.migrate")(
    Effect.fn(function* ({ stack, stage, rollback, ...args }) {
      const result = yield* source(args).pipe(
        Effect.flatMap((source) => Alchemist.State.migrate(source, { stack, stage, rollback })),
      );
      if (result.stages.length === 0) {
        yield* Interaction.info("No stages to migrate.");
        return;
      }
      for (const entry of result.stages) {
        const detail =
          entry.reason ?? (entry.records === undefined ? "" : `${entry.records} records`);
        yield* Console.log(
          `${entry.stack}/${entry.stage}: ${entry.status}${detail === "" ? "" : ` (${detail})`}`,
        );
      }
      const unfinished = result.stages.filter(
        (entry) => entry.status === "blocked" || entry.status === "failed",
      );
      if (unfinished.length > 0) {
        return yield* new UserInputError({
          message: `${unfinished.length} stage(s) did not move. Run the command again once the deploys holding them finish, or fix the failures above.`,
        });
      }
      yield* Interaction.success(
        rollback ? "Rolled back the state store" : "Migrated the state store",
      );
    }),
  ),
).pipe(
  Command.withDescription(
    "Move stages into the configured state store from the one it replaces (or --backend)",
  ),
);

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
      const target = yield* lifecycleSource(args);
      const format = (entry: Contributions.StateStoreLogEntry) =>
        `${formatLocalTimestamp(entry.timestamp)} ${entry.message}`;
      if (tail) {
        yield* Interaction.info(`Tailing the ${args.backend} state store...`);
        yield* Alchemist.State.tailLogs(target).pipe(
          Stream.runForEach((entry) => Console.log(format(entry))),
        );
        return;
      }
      const entries = yield* Alchemist.State.logs({
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

const stateFlags = { main: config, envFile, profile, backend };
const stateSubcommands = [
  listCommand,
  readCommand,
  deleteCommand,
  bootstrapCommand,
  teardownCommand,
  migrateCommand,
  logsCommand,
  unsafeCommand,
] as const;

/**
 * Whether a store's flag clashes with one of `alchemy state`'s own flags or
 * its subcommands', found the way effect finds them: by building the command.
 * Effect only checks direct subcommands, so `unsafe nuke` is listed too.
 */
const clashes = (flag: Flag.Flag<unknown>) => {
  const built = Result.try(() =>
    Command.make("state", {}).pipe(
      Command.withSharedFlags({ flag }),
      Command.withSubcommands([
        Command.make("state", stateFlags),
        ...stateSubcommands,
        nukeCommand,
      ]),
    ),
  );
  if (Result.isSuccess(built)) return false;
  if (Schema.is(CliError.DuplicateOption)(built.failure)) return true;
  throw built.failure;
};

/** A store's flag, read through the combinators it is wrapped in. */
const readFlag = (backend: string, option: string, flag: Flag.Flag<unknown>) => {
  let param: Param.Param<"flag", unknown> = flag;
  // A default wraps the flag in `optional`, so either means it is always set.
  let optional = false;
  while (!Param.isSingle(param) && Predicate.hasProperty(param, "param")) {
    optional ||= param._tag === "Optional";
    param = param.param as Param.Param<"flag", unknown>;
  }
  const single = Param.isSingle(param) ? param : undefined;
  return {
    backend,
    option,
    flag,
    optional,
    name: single?.name ?? option,
    type: single?.primitiveType._tag,
    aliases: single?.aliases ?? [],
    description: single === undefined ? "" : Option.getOrElse(single.description, () => ""),
  };
};

type StoreFlag = ReturnType<typeof readFlag>;

/** Why a store's flag can't join the ones already accepted, if it can't. */
const rejection = (flag: StoreFlag, accepted: ReadonlyArray<StoreFlag>) => {
  if (flag.optional) return "state store flags can't be optional or have a default";
  if (flag.aliases.length > 0) return "state store flags can't have aliases";
  const shared = accepted.find((other) => other.option === flag.option);
  if (shared !== undefined) {
    if (shared.name !== flag.name) return `'${flag.option}' is already set with --${shared.name}`;
    if (shared.type !== flag.type) return `another state store parses it as ${shared.type}`;
    return undefined;
  }
  const sameName = accepted.find((other) => other.name === flag.name);
  if (sameName !== undefined) return `it already sets '${sameName.option}'`;
  if (clashes(flag.flag)) return "alchemy state already has that flag";
  return undefined;
};

/** One optional flag for the stores sharing an option, its help listing each one. */
const sharedFlag = (stores: Arr.NonEmptyReadonlyArray<StoreFlag>) => {
  const help = Object.entries(Arr.groupBy(stores, (store) => store.description))
    .map(([description, same]) =>
      `${description} (--backend ${same.map((store) => store.backend).join(", ")})`.trim(),
    )
    .join("; ");
  return stores[0].flag.pipe(
    Flag.withDescription(help),
    Flag.optional,
    Flag.map(Option.getOrUndefined),
  );
};

/**
 * The flags of every provider's state store, such as `--name` or `--domain`,
 * each optional so a flag not given is `undefined`. Stores that set the same
 * option with the same flag share it. A flag that can't be added is left out
 * with a warning, and `ignored` lists it so the CLI refuses that option for
 * its store. Which ones a backend takes is checked when the store is opened.
 *
 * @internal exported for tests.
 */
export const storeOptionFlags = (contributions: ReadonlyArray<Contributions.Contributions>) => {
  const accepted: Array<StoreFlag> = [];
  // backend -> the options whose flag was left out
  const ignored: Record<string, Array<string>> = {};
  for (const provider of contributions) {
    for (const [backend, store] of Object.entries(provider.stateStores ?? {})) {
      for (const [option, flag] of Object.entries(store.flags ?? {})) {
        const read = readFlag(backend, option, flag);
        const problem = rejection(read, accepted);
        if (problem === undefined) {
          accepted.push(read);
          continue;
        }
        Effect.runSync(
          Effect.logWarning(
            `Ignoring --${read.name} from the '${backend}' state store: ${problem}.`,
          ),
        );
        ignored[backend] = [...(ignored[backend] ?? []), option];
      }
    }
  }
  const flags = Record.map(
    Arr.groupBy(accepted, (flag) => flag.option),
    sharedFlag,
  );
  return { flags, ignored };
};

/**
 * `alchemy state`, sharing a flag with every subcommand for each one the
 * loaded providers' state stores contribute.
 */
export const stateCommand = (contributions: ReadonlyArray<Contributions.Contributions>) => {
  const { flags, ignored } = storeOptionFlags(contributions);
  return Command.make(
    "state",
    stateFlags,
    instrumentCommand("state")(
      Effect.fn(function* (args) {
        if (!(yield* Interaction.Interaction).terminal.input) {
          return yield* failWithHelp(["alchemy", "state"]);
        }
        yield* stateExplorer(args);
      }),
    ),
  ).pipe(
    Command.withDescription("Inspect and manage deployment state"),
    Command.withSharedFlags({ storeOptions: flags }),
    Command.withSubcommands(stateSubcommands),
    // After the subcommands, so their handlers get the shared store options too.
    Command.provideSync(StoreOptions, ({ storeOptions }) => ({ given: storeOptions, ignored })),
  );
};
