import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Argument from "effect/unstable/cli/Argument";
import { Command, Flag } from "effect/unstable/cli";
import * as Cloudflare from "../../Alchemist/routes/cloudflare.ts";
import * as AlchemistState from "../../Alchemist/routes/state.ts";
import type { StateSource } from "../../Alchemist/routes/state.ts";
import * as State from "../../State/index.ts";
import * as CliKit from "../../Cli/CliKit/index.ts";
import {
  stateExplorerScreen,
  type StateExplorerSource,
} from "../components/view/StateExplorer.tsx";
import { failWithHelp, UserInputError } from "./errors.ts";
import { envFile, profile, yes } from "./flags.ts";
import { confirmOrDecline } from "./confirm.ts";
import { instrumentCommand } from "./instrument.ts";

const backend = Flag.Literals("backend", [
  "configured",
  "local",
  "cloudflare",
  "aws",
] as const).pipe(
  Flag.withDescription("State backend (default: configured)"),
  Flag.withDefault("configured" as const),
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
  readonly backend: "configured" | "local" | "cloudflare" | "aws";
};

const source = (args: StateArgs): StateSource =>
  args.backend === "local"
    ? { backend: "local" }
    : args.backend === "cloudflare" || args.backend === "aws"
      ? {
          backend: args.backend,
          profile: args.profile,
          envFile: Option.getOrUndefined(args.envFile),
        }
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

const provideStore =
  (store: State.StateService) =>
  <A, E>(operation: Effect.Effect<A, E, State.State>) =>
    operation.pipe(Effect.provideService(State.State, Effect.succeed(store)));

/** Run a state tree operation against a resolved store, mapping a bad path
 * to a single-line user error instead of a cause dump. */
const usingStore =
  (store: State.StateService) =>
  <A>(
    operation: Effect.Effect<
      A,
      State.InvalidStatePath | State.StateStoreError,
      State.State
    >,
  ) =>
    provideStore(store)(operation).pipe(
      Effect.catchTag("InvalidStatePath", (error) =>
        Effect.fail(
          new UserInputError({ message: `${error.path}: ${error.reason}` }),
        ),
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
          path: yield* normalizedPath(Option.getOrUndefined(path)),
          recursive,
        }),
      );
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
      const store = yield* AlchemistState.store(source(args));
      const requested = yield* normalizedPath(Option.getOrUndefined(path));
      const entries = yield* usingStore(store)(
        State.readState({ path: requested, recursive }),
      );
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
      const store = yield* AlchemistState.store(source(args));
      yield* usingStore(store)(
        State.deleteState({ path: requested, recursive }),
      );
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
          Effect.map((paths) =>
            paths.map((path) => path.slice(stack.length + 1, -1)),
          ),
        ),
      listResources: (stack, stage) =>
        on(
          State.listState({ path: `${stack}/${stage}`, recursive: true }),
        ).pipe(
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
              : on(
                  State.deleteState({ path: node.path, recursive: true }),
                ).pipe(Effect.asVoid),
          { concurrency: 32, discard: true },
        ),
    };
    // Captured here so the explorer's forked fibers run with the command's
    // ambient services (tracing, terminal) rather than the default runtime.
    const services = yield* Effect.context<never>();
    yield* cli
      .application(cli.prompt.custom(stateExplorerScreen(explorer, services)))
      .pipe(CliKit.Application.alternate)
      .pipe(Effect.catchTag("TerminalCancelled", () => Effect.void));
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
            .pipe(
              Effect.andThen(
                CliKit.accessors.output.success(`Cleared ${stack}`),
              ),
            ),
        { concurrency: 32, discard: true },
      );
    }),
  ),
).pipe(
  Command.withDescription(
    "Delete all stacks, stages, and outputs from the state store",
  ),
  Command.unlisted,
);

const unsafeCommand = Command.make("unsafe", {}).pipe(
  Command.withDescription("Destructive state operations"),
  Command.withSubcommands([nukeCommand]),
  Command.unlisted,
);

type CloudflareStateArgs = {
  readonly envFile: Option.Option<string>;
  readonly profile: string | undefined;
};

const cloudflareTarget = (args: CloudflareStateArgs) => ({
  profile: args.profile,
  envFile: Option.getOrUndefined(args.envFile),
});

const protectCommand = Command.make(
  "protect",
  { envFile, profile, yes },
  instrumentCommand("state.protect")(
    Effect.fn(function* ({ yes, ...args }) {
      yield* confirmOrDecline({
        yes,
        message:
          "Put the Cloudflare state store behind Cloudflare Access? Members of the Cloudflare account " +
          "sign in with their Cloudflare account; CI needs a token from 'alchemy state token create'.",
        confirmLabel: "Protect",
        cancelLabel: "Cancel",
      });
      const result = yield* Cloudflare.protect(cloudflareTarget(args));
      yield* CliKit.accessors.output.success(
        result.status === "protected"
          ? `The state store at ${result.host} is now protected by Cloudflare Access.`
          : `Cloudflare Access for the state store at ${result.host} is up to date.`,
      );
      if (result.status === "protected") {
        yield* CliKit.accessors.output.info(
          "Create a token for each CI pipeline with 'alchemy state token create <name>'.",
        );
      }
    }),
  ),
).pipe(
  Command.withDescription(
    "Protect the Cloudflare state store with Cloudflare Access (Cloudflare account members only)",
  ),
);

const unprotectCommand = Command.make(
  "unprotect",
  { envFile, profile, yes },
  instrumentCommand("state.unprotect")(
    Effect.fn(function* ({ yes, ...args }) {
      yield* confirmOrDecline({
        yes,
        message:
          "Remove Cloudflare Access from the state store and delete its tokens? " +
          "The store stays protected by its bearer token.",
        confirmLabel: "Remove",
        cancelLabel: "Cancel",
      });
      const result = yield* Cloudflare.unprotect(cloudflareTarget(args));
      yield* result.status === "unprotected"
        ? CliKit.accessors.output.success(
            "Removed Cloudflare Access from the state store.",
          )
        : CliKit.accessors.output.info(
            "The state store is not protected by Cloudflare Access.",
          );
    }),
  ),
).pipe(
  Command.withDescription("Remove Cloudflare Access from the state store"),
);

const loginCommand = Command.make(
  "login",
  { envFile, profile },
  instrumentCommand("state.login")(
    Effect.fn(function* (args) {
      const result = yield* Cloudflare.stateLogin(cloudflareTarget(args));
      yield* result.protected
        ? CliKit.accessors.output.success(
            `Logged in to Cloudflare Access for ${result.host}.`,
          )
        : CliKit.accessors.output.info(
            `The state store at ${result.host} is not protected by Cloudflare Access; there is nothing to log in to.`,
          );
    }),
  ),
).pipe(
  Command.withDescription(
    "Log in to Cloudflare Access for the state store (deploys prompt automatically)",
  ),
);

const tokenName = Argument.String("name").pipe(
  Argument.withDescription("Token name, e.g. github-actions"),
);

const tokenCreateCommand = Command.make(
  "create",
  { name: tokenName, envFile, profile },
  instrumentCommand("state.token.create")(
    Effect.fn(function* ({ name, ...args }) {
      const token = yield* Cloudflare.createStateToken({
        ...cloudflareTarget(args),
        name,
      });
      yield* Console.log(
        [
          "",
          `Created state store token "${token.name}"${token.expiresAt ? ` (expires ${token.expiresAt})` : ""}.`,
          "",
          `CLOUDFLARE_ACCESS_CLIENT_ID=${token.clientId}`,
          `CLOUDFLARE_ACCESS_CLIENT_SECRET=${Redacted.value(token.clientSecret)}`,
          "",
          "Add both values as secrets in your CI provider.",
        ].join("\n"),
      );
    }),
  ),
).pipe(
  Command.withDescription(
    "Create a service token that CI/CD uses to reach the protected state store",
  ),
);

const tokenListCommand = Command.make(
  "list",
  { envFile, profile },
  instrumentCommand("state.token.list")(
    Effect.fn(function* (args) {
      const tokens = yield* Cloudflare.listStateTokens(cloudflareTarget(args));
      if (tokens.length === 0) {
        yield* CliKit.accessors.output.info(
          "No tokens. Create one with 'alchemy state token create <name>'.",
        );
        return;
      }
      yield* Console.log(
        tokens
          .map(
            (token) =>
              `${token.name}\t${token.clientId ?? ""}\t${token.expiresAt ? `expires ${token.expiresAt}` : ""}`,
          )
          .join("\n"),
      );
    }),
  ),
).pipe(
  Command.withAlias("ls"),
  Command.withDescription("List the state store's service tokens"),
);

const tokenRevokeCommand = Command.make(
  "revoke",
  { name: tokenName, envFile, profile, yes },
  instrumentCommand("state.token.revoke")(
    Effect.fn(function* ({ name, yes, ...args }) {
      yield* confirmOrDecline({
        yes,
        message: `Revoke state store token '${name}'? Pipelines using it lose access immediately.`,
        confirmLabel: "Revoke",
        cancelLabel: "Cancel",
      });
      yield* Cloudflare.revokeStateToken({ ...cloudflareTarget(args), name });
      yield* CliKit.accessors.output.success(`Revoked token '${name}'.`);
    }),
  ),
).pipe(Command.withDescription("Revoke a state store service token"));

const tokenCommand = Command.make("token", {}).pipe(
  Command.withDescription(
    "Manage service tokens for the protected Cloudflare state store",
  ),
  Command.withSubcommands([
    tokenCreateCommand,
    tokenListCommand,
    tokenRevokeCommand,
  ]),
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
    protectCommand,
    unprotectCommand,
    loginCommand,
    tokenCommand,
    unsafeCommand,
  ]),
);
