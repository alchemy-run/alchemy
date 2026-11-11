import * as boat from "@distilled.cloud/boat-dev/boat";
import { Unowned } from "alchemy/AdoptPolicy";
import type * as Bundle from "alchemy/Bundle/Bundle";
import { isResolved } from "alchemy/Diff";
import { Platform, type Main, type PlatformProps } from "alchemy/Platform";
import * as Provider from "alchemy/Provider";
import { Resource, type ResourceBinding } from "alchemy/Resource";
import {
  createHostRuntimeContext,
  type HostRuntimeContext,
  type ServerHost,
} from "alchemy/Runtime/Process";
import { Stack } from "alchemy/Stack";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Stream from "effect/Stream";
import { isDeclaration } from "./internal/Declared.ts";
import {
  boatName,
  hasAnyAlchemyLabel,
  hasOwnershipLabels,
  ownershipLabels,
  userLabels,
} from "./internal/Ownership.ts";
import {
  bundleProgram,
  DEFAULT_PORT,
  deployProgram,
  isProgramRunning,
  type ProgramState,
} from "./internal/Program.ts";
import { resolved, type Ref } from "./internal/Ref.ts";
import type { Providers } from "./Providers.ts";
import type { SnapshotBase } from "./Snapshot.ts";

/**
 * Machine size. `small` runs at half the default rate and `large` at
 * twice; `xlarge` needs the $100/month plan or higher.
 */
export type SandboxType = "small" | "default" | "large" | "xlarge";

/** Where a sandbox is in its life. `archived` is stopped, with its disk saved. */
export type SandboxState =
  | "init"
  | "provisioning"
  | "provisioned"
  | "cloning"
  | "ready"
  | "idle"
  | "running"
  | "archiving"
  | "archived"
  | "error"
  | "cancelled";

/** How the setup script went: `pending`, `running`, `done` or `failed`. */
export type SandboxSetupStatus = "pending" | "running" | "done" | "failed";

/** An environment, by name. Accepts a `Boat.Environment` or `{ name }`. */
export interface SandboxEnvironmentRef {
  name: string;
}

/** What bindings attach to a sandbox that runs a program: its process's environment. */
export interface SandboxBinding {
  env?: Record<string, any>;
}

export interface SandboxProps extends PlatformProps {
  /**
   * Display name. If omitted, a unique name is generated from the stack,
   * stage and logical ID. Renamed in place.
   */
  name?: string;
  /**
   * Machine size. Changing it replaces the sandbox.
   * @default "default"
   */
  type?: SandboxType;
  /**
   * How long the sandbox runs before Boat stops it, saving its disk;
   * `false` never stops it. Updated in place: the next stop is then
   * `autoStop` from the deploy.
   * @default "1 hour", or `false` for a sandbox with `main`
   */
  autoStop?: Duration.Input | false;
  /**
   * Environment variables. On a sandbox without `main` they are the
   * sandbox's, on top of its environment's, and changing them replaces it.
   * On a sandbox with `main` they are the program's, and changing them
   * restarts it.
   */
  env?: Record<string, string | Redacted.Redacted<string>>;
  /**
   * The `Boat.Environment` to attach (or `{ name }` of one): its
   * variables, secret files and credential settings. Omit for the account's
   * default environment (`base`). Changing it replaces the sandbox.
   */
  environment?: Ref<SandboxEnvironmentRef>;
  /**
   * Attach none of the account's secrets (no environment variables, secret
   * files or credentials), and confine the sandbox so it can't act on the
   * account. For sandboxes you give to your own users. Changing it replaces
   * the sandbox.
   * @default false
   */
  noEnv?: boolean;
  /**
   * `false` never snapshots the sandbox: stopping it erases its disk, and it
   * can't be resumed, forked or saved. Changing it replaces the sandbox.
   * @default true
   */
  snapshots?: boolean;
  /**
   * `false` keeps no command output, process list or metrics for the
   * sandbox. Changing it replaces the sandbox.
   * @default true
   */
  monitoring?: boolean;
  /**
   * A shell script run once, in the background, after the sandbox starts.
   * Its outcome is `setupStatus`. Changing it replaces the sandbox.
   */
  setupScript?: string;
  /**
   * The `Boat.Snapshot` to start from (or `{ name }` of one saved
   * elsewhere, or a share code `bsh_...`). Changing or rebuilding it
   * replaces the sandbox, so it starts from the new disk.
   */
  snapshot?: Ref<SnapshotBase>;
  /**
   * Your own labels, at most 17 (Alchemy adds three). Boat sets labels
   * only at create, so changing them replaces the sandbox.
   */
  labels?: Record<string, string>;
  /**
   * The sandbox's subdomain under `on.boat.dev`. Port `p` answers at
   * `https://<subdomain>-<p>.on.boat.dev`. Renamed in place.
   */
  subdomain?: string;
  /**
   * Module entrypoint of a program to run in the sandbox, typically
   * `import.meta.url` in the class form. Alchemy bundles it, uploads it
   * into the sandbox and runs it with Node 24; a code change uploads it
   * again and restarts the process, without replacing the sandbox.
   */
  main?: string;
  /**
   * Port the program listens on. Written to `PORT`; Boat serves it at
   * `url`.
   * @default 3000
   */
  port?: number;
  /**
   * Serve the program's port to anyone. Otherwise requests need `urlToken`
   * (as the `_token` query parameter, or the `_port_auth` cookie).
   * Updated in place.
   * @default false
   */
  public?: boolean;
  /**
   * Named export to load from `main`.
   * @default "default"
   */
  handler?: string;
  /** Bundler configuration for `main`. */
  build?: Bundle.BundleConfig;
  /**
   * Who in the organization that pays for the sandbox can use it:
   * `private`, only you; `shared`, every member. Omitted, the organization's
   * default for new sandboxes applies. Updated in place. Sharing a sandbox
   * that holds your logins (GitHub, Claude and Codex logins, environment
   * secrets) wipes them at its next start and never pushes them again, so
   * share one with `noEnv` or an environment that passes nothing. A
   * personal sandbox is always private, and Boat refuses `shared` for one.
   */
  visibility?: "shared" | "private";
}

export interface SandboxAttributes {
  /** Boat's sandbox id (`bx_…`). */
  sandboxId: string;
  name: string;
  /** `ready`, `running`, `idle`, `archived` (stopped), … */
  state: SandboxState;
  type: SandboxType | undefined;
  /** vCPUs and RAM (GB) the machine size guarantees. */
  vcpu: number | undefined;
  memoryGB: number | undefined;
  /**
   * The subdomain its ports are served under: port `p` answers at
   * `https://<subdomain>-<p>.on.boat.dev`.
   */
  subdomain: string | undefined;
  /** The machine's URL. */
  machineUrl: string | undefined;
  /** The environment the sandbox runs, and its version. */
  environment: string | undefined;
  environmentVersion: number | undefined;
  /** Seconds it runs before stopping, or `undefined` when it never stops. */
  ttlSeconds: number | undefined;
  /** Your labels, without Alchemy's. */
  labels: Record<string, string>;
  /** The setup script's outcome: `pending`, `running`, `done` or `failed`. */
  setupStatus: SandboxSetupStatus | undefined;
  /** The program's URL, for a sandbox with `main`. */
  url: string | undefined;
  /**
   * The token a request to `url` needs unless the sandbox is `public`: the
   * `_token` query parameter, or the `_port_auth` cookie.
   */
  urlToken: Redacted.Redacted<string> | undefined;
  /** The program the sandbox runs, for a sandbox with `main`. */
  program: ProgramState | undefined;
  /**
   * The organization that pays for it, fixed when it was created;
   * `undefined` when you do.
   */
  org: { id: string; name: string } | undefined;
  /** `shared` or `private` for an organization's sandbox; `undefined` for yours. */
  visibility: "shared" | "private" | undefined;
}

export type Sandbox = Resource<
  "Boat.Sandbox",
  SandboxProps,
  SandboxAttributes,
  SandboxBinding,
  Providers,
  { sandboxId: string }
>;

export type SandboxServices = ServerHost;

/** A program's shape: a long-running server returning `{ fetch }`, or `host.run` loops. */
export type SandboxShape = Main<SandboxServices>;

export type SandboxRuntimeContext = HostRuntimeContext;

/**
 * A Boat sandbox the stack owns: a Linux machine with Docker, passwordless
 * `sudo` and a desktop, that stops itself after `autoStop` and keeps its
 * disk until it is resumed.
 *
 * Use it for a workspace that outlives requests (an agent's home, a dev
 * box, a preview environment). Bindings create short-lived sandboxes at
 * run time with `Boat.CreateSandbox`.
 *
 * Alchemy labels the sandbox with its stack, stage and logical ID
 * (`alchemy.stack`, `alchemy.stage`, `alchemy.id`) to recognise the
 * sandboxes it owns.
 *
 * The sandbox bills the stack's organization (`Boat.providers({ org })`,
 * or the profile's), else your active wallet. Boat fixes the wallet at
 * create, so changing the stack's `org` later leaves the sandbox where it
 * is; `org` says which.
 *
 * :::caution
 * Replacing the sandbox (a new `type`, `env`, `environment`, `noEnv`,
 * `snapshots`, `monitoring`, `setupScript`, `labels`, or a new or rebuilt
 * `snapshot`) creates a fresh sandbox and deletes the old one with its disk.
 * :::
 *
 * ### Creating a Sandbox
 * **Example:** A dev box that stops after an idle hour
 * ```typescript
 * import * as Boat from "@alchemy.run/boat";
 *
 * export const DevBox = Boat.Sandbox("DevBox", {
 *   type: "large",
 *   autoStop: "1 hour",
 *   setupScript: "git clone https://github.com/alchemy-run/alchemy ~/alchemy",
 * });
 * ```
 *
 * **Example:** A sandbox with none of the account's secrets
 * ```typescript
 * export const Untrusted = Boat.Sandbox("Untrusted", {
 *   noEnv: true,
 *   env: { TASK: "lint" },
 * });
 * ```
 *
 * ### Running a Program
 * The class form runs an Effect program in the sandbox: give it `main` and
 * an implementation, and Alchemy bundles the program, uploads it and runs
 * it with Node, served at `url`. A code change uploads the new bundle and
 * restarts the process; the sandbox and its URL stay the same. A sandbox
 * with `main` never stops on its own unless `autoStop` says so; if it
 * stopped anyway, the next deploy resumes it and starts the program.
 *
 * **Example:** An HTTP server
 * ```typescript
 * export default class Api extends Boat.Sandbox<Api>()(
 *   "Api",
 *   { main: import.meta.url, public: true },
 *   Effect.gen(function* () {
 *     return {
 *       fetch: Effect.gen(function* () {
 *         return yield* HttpServerResponse.json({ ok: true });
 *       }),
 *     };
 *   }),
 * ) {}
 * ```
 *
 * ### Starting from a snapshot and an environment
 * **Example:** A sandbox with a project set up and its secrets
 * ```typescript
 * export const Golden = Boat.Snapshot("Golden", { run: ["npm i -g pnpm"] });
 * export const MyEnv = Boat.Environment("MyEnv", {
 *   env: { API_TOKEN: Config.Redacted("API_TOKEN") },
 * });
 *
 * export const Box = Boat.Sandbox("Box", {
 *   snapshot: Golden,
 *   environment: MyEnv,
 *   autoStop: "30 minutes",
 * });
 * ```
 *
 * ### Sharing with an organization
 * **Example:** A sandbox every member of the team can use
 * ```typescript
 * // with Boat.providers({ org: "acme" }) on the stack
 * export const TeamBox = Boat.Sandbox("TeamBox", {
 *   noEnv: true,
 *   visibility: "shared",
 * });
 * ```
 *
 * ### Using it at runtime
 * **Example:** Run a command in it from a Worker
 * ```typescript
 * const devBox = yield* Boat.ConnectSandbox(DevBox);
 * // in fetch:
 * yield* devBox.resume();
 * const result = yield* devBox.exec("git pull && npm test", { cwd: "/home/user/repo" });
 * ```
 *
 * ### Referencing a sandbox the stack doesn't manage
 * **Example:** Look one up by id
 * ```typescript
 * const shared = Boat.Sandbox.lookup({ sandboxId: "bx_abc123" });
 * const box = yield* Boat.ConnectSandbox(shared);
 * ```
 *
 * @resource
 * @product Sandbox
 */
/** The plain resource behind {@link Sandbox}, which carries `lookup`. */
const SandboxResource = Resource<Sandbox>("Boat.Sandbox");

export const Sandbox: Platform<Sandbox, SandboxServices, SandboxShape, SandboxRuntimeContext> & {
  /** References a sandbox the stack doesn't manage, by id. */
  readonly lookup: ReturnType<typeof Resource<Sandbox>>["lookup"];
} = Object.assign(
  Platform("Boat.Sandbox", {
    createRuntimeContext: createHostRuntimeContext("Boat.Sandbox"),
    // A declaration passed as a prop (`snapshot: Golden`) is an Effect until
    // yielded. Yield it here so it is registered and the prop resolves to
    // its attributes, as with `yield* Golden` inside Effect.gen.
    transformProps: (_id, props: SandboxProps) =>
      Effect.gen(function* () {
        if (globalThis.__ALCHEMY_RUNTIME__) return props;
        // A lookup (`Boat.Environment.lookup({ name })`) is an Output, which
        // the engine resolves; only a declaration is yielded.
        const ref = <T>(value: T) =>
          isDeclaration(value)
            ? (value as unknown as Effect.Effect<T, never, Providers>)
            : Effect.succeed(value);
        return {
          ...props,
          snapshot: props.snapshot === undefined ? undefined : yield* ref(props.snapshot),
          environment: props.environment === undefined ? undefined : yield* ref(props.environment),
        };
      }),
  }),
  { lookup: (props: { sandboxId: string }) => SandboxResource.lookup(props) },
);

/** A sandbox, or `undefined` when Boat no longer has it. */
export const observeSandbox = (sandboxId: string) =>
  boat.getSandbox({ sandboxId }).pipe(
    Effect.map((got) =>
      got.sandbox === undefined || got.sandbox.state === "cancelled" ? undefined : got.sandbox,
    ),
    Effect.catchTag("NotFound", () => Effect.undefined),
  );

/** Delete a sandbox; deleting one that is gone succeeds. */
export const deleteSandbox = (sandboxId: string) =>
  boat.deleteSandbox({ sandboxId, xAsciiConfirmDelete: sandboxId }).pipe(
    Effect.asVoid,
    Effect.catchTag("NotFound", () => Effect.void),
  );

const plainEnv = (env: SandboxProps["env"]) =>
  env === undefined
    ? undefined
    : Object.fromEntries(
        Object.entries(env).map(([key, value]) => [
          key,
          Redacted.isRedacted(value) ? Redacted.value(value) : value,
        ]),
      );

export const toAttributes = (sandbox: boat.Sandbox): SandboxAttributes => ({
  sandboxId: sandbox.id,
  name: sandbox.name,
  state: sandbox.state,
  type: sandbox.type,
  vcpu: sandbox.vcpu,
  memoryGB: sandbox.memoryGB,
  subdomain: sandbox.subdomain ?? undefined,
  machineUrl: sandbox.url ?? undefined,
  environment: sandbox.environment ?? undefined,
  environmentVersion: sandbox.environmentVersion ?? undefined,
  ttlSeconds: sandbox.ttlSeconds ?? undefined,
  labels: userLabels(sandbox.labels),
  setupStatus: sandbox.setupStatus ?? undefined,
  url: undefined,
  urlToken: undefined,
  program: undefined,
  org: sandbox.team ? { id: sandbox.team.id, name: sandbox.team.name } : undefined,
  visibility: sandbox.visibility ?? undefined,
});

/** The bindings still attached (a removed binding arrives as a `delete`). */
const activeBindings = (bindings: ReadonlyArray<ResourceBinding<SandboxBinding>>) =>
  bindings.filter(
    (binding: ResourceBinding<SandboxBinding> & { action?: string }) => binding.action !== "delete",
  );

/** The program's environment from its bindings. */
const bindingEnv = (bindings: ReadonlyArray<ResourceBinding<SandboxBinding>>) =>
  activeBindings(bindings).reduce<Record<string, any>>(
    (acc, binding) => ({ ...acc, ...binding.data?.env }),
    {},
  );

/**
 * Boat's `ttlSeconds` for `autoStop`: `null` never stops. Without
 * `autoStop`, a program sandbox never stops and others keep Boat's default.
 */
const ttlSecondsOf = (autoStop: Duration.Input | false | undefined, program: boolean) =>
  autoStop === false
    ? null
    : autoStop === undefined
      ? program
        ? null
        : undefined
      : Math.max(1, Math.round(Duration.toMillis(Duration.fromInputUnsafe(autoStop)) / 1000));

/** Props whose change means a new sandbox (Boat can't change them on a live one). */
const replacingProps = (props: SandboxProps) =>
  JSON.stringify({
    type: props.type ?? "default",
    // A program's env is its process's: changing it restarts the program.
    env: props.main === undefined ? (plainEnv(props.env) ?? {}) : undefined,
    program: props.main !== undefined,
    environment: props.environment === undefined ? undefined : resolved(props.environment).name,
    noEnv: props.noEnv ?? false,
    snapshots: props.snapshots ?? true,
    monitoring: props.monitoring ?? true,
    setupScript: props.setupScript,
    snapshot:
      props.snapshot === undefined
        ? undefined
        : [resolved(props.snapshot).name, resolved(props.snapshot).setupHash ?? null],
    labels: props.labels ?? {},
  });

export const SandboxProvider = () =>
  Provider.effect(
    Sandbox,
    Effect.gen(function* () {
      const stack = yield* Stack;
      // The bundled program's bootstrap reads these to rebuild the Stack at runtime.
      const alchemyEnv = {
        ALCHEMY_STACK_NAME: stack.name,
        ALCHEMY_STAGE: stack.stage,
        ALCHEMY_PHASE: "runtime",
        HOST: "0.0.0.0",
      };
      return {
        stables: ["sandboxId"],
        diff: Effect.fn(function* ({ news, olds, output }) {
          if (olds === undefined) return undefined;
          // A program's props are partly unresolved at plan (its bindings'
          // env holds Outputs); the replacing ones are compared once known.
          if (isResolved(news) && replacingProps(olds) !== replacingProps(news)) {
            return { action: "replace" } as const;
          }
          // The bundle depends only on `main`, `handler` and `build`, which
          // are plain. A code change, or a process that ended (the sandbox
          // stopped or rebooted), redeploys the program in place.
          const props = news as SandboxProps;
          if (typeof props.main === "string" && output !== undefined) {
            const { hash } = yield* bundleProgram({ ...props, main: props.main });
            if (output.program === undefined || hash !== output.program.codeHash) {
              return { action: "update" } as const;
            }
            if (!(yield* isProgramRunning(output.sandboxId, output.program))) {
              return { action: "update" } as const;
            }
          }
          return undefined;
        }),
        read: Effect.fn(function* ({ id, output }) {
          if (output === undefined) return undefined;
          const sandbox = yield* observeSandbox(output.sandboxId);
          if (sandbox === undefined) return undefined;
          // The program isn't visible on the sandbox; keep what the last deploy recorded.
          const attrs = {
            ...toAttributes(sandbox),
            url: output.url,
            urlToken: output.urlToken,
            program: output.program,
          };
          return (yield* hasOwnershipLabels(id, sandbox.labels)) ? attrs : Unowned(attrs);
        }),
        lookup: Effect.fn(function* ({ sandboxId }) {
          const sandbox = yield* observeSandbox(sandboxId);
          return sandbox === undefined ? undefined : toAttributes(sandbox);
        }),
        reconcile: Effect.fn(function* ({ id, news, output, bindings, session }) {
          const name = yield* boatName(id, news.name ?? output?.name, 120);
          const owner = yield* ownershipLabels(id);
          const program = news.main !== undefined;
          // A program serves for as long as the sandbox runs: don't stop it on a timer.
          const ttlSeconds = ttlSecondsOf(news.autoStop, program);

          // Observe — `output` caches the id; the sandbox may be gone.
          let sandbox = output === undefined ? undefined : yield* observeSandbox(output.sandboxId);

          // Ensure
          if (sandbox === undefined) {
            yield* session.note(`Creating sandbox ${name}...`);
            const created = yield* boat.createSandbox({
              ...(news.type === undefined ? {} : { type: news.type }),
              ...(ttlSeconds === undefined ? {} : { ttlSeconds }),
              // A program's env is its process's, written at deploy, not the sandbox's.
              ...(news.env === undefined || program ? {} : { env: plainEnv(news.env) }),
              ...(news.environment === undefined
                ? {}
                : { environment: resolved(news.environment).name }),
              ...(news.noEnv === undefined ? {} : { noEnv: news.noEnv }),
              ...(news.snapshots === undefined ? {} : { snapshots: news.snapshots }),
              ...(news.monitoring === undefined ? {} : { monitoring: news.monitoring }),
              ...(news.setupScript === undefined ? {} : { setupScript: news.setupScript }),
              ...(news.snapshot === undefined ? {} : { from: resolved(news.snapshot).name }),
              ...(news.visibility === undefined ? {} : { visibility: news.visibility }),
              labels: { ...news.labels, ...owner },
            });
            sandbox = created.sandbox;
          }

          // Sync — a stopped program sandbox is resumed, so the program can run.
          if (program && sandbox.state === "archived") {
            yield* session.note(`Resuming sandbox ${name}...`);
            const resumed = yield* boat.resumeSandbox({ sandboxId: sandbox.id });
            sandbox = resumed.sandbox ?? sandbox;
          }

          // Sync — name, subdomain and auto-stop, against what Boat reports.
          const ttlChanged =
            ttlSeconds !== undefined && (sandbox.ttlSeconds ?? null) !== ttlSeconds;
          const subdomainChanged =
            news.subdomain !== undefined && sandbox.subdomain !== news.subdomain;
          if (sandbox.name !== name || ttlChanged || subdomainChanged) {
            const updated = yield* boat.updateSandbox({
              sandboxId: sandbox.id,
              ...(sandbox.name !== name ? { name } : {}),
              ...(ttlChanged ? { ttlSeconds } : {}),
              ...(subdomainChanged ? { subdomain: news.subdomain } : {}),
            });
            sandbox = updated.sandbox ?? sandbox;
          }

          // Sync — visibility, against what Boat reports.
          if (
            news.visibility !== undefined &&
            (sandbox.visibility ?? "private") !== news.visibility
          ) {
            yield* session.note(
              `Making sandbox ${name} ${news.visibility === "shared" ? "shared" : "private"}...`,
            );
            if (news.visibility === "shared") {
              const shared = yield* boat.shareSandbox({ sandboxId: sandbox.id });
              if (shared.restartRequired) {
                yield* session.note(
                  `Sandbox ${name} is shared from its next start: stop and resume it to share it now.`,
                );
              }
            } else {
              yield* boat.unshareSandbox({ sandboxId: sandbox.id });
            }
            sandbox = (yield* observeSandbox(sandbox.id)) ?? sandbox;
          }

          const attrs = toAttributes(sandbox);
          if (news.main === undefined) return attrs;

          // Deploy the program into the running sandbox, then host its port.
          const port = news.port ?? DEFAULT_PORT;
          const state = yield* deployProgram({
            id,
            sandboxId: sandbox.id,
            source: { ...news, main: news.main },
            port,
            env: { ...bindingEnv(bindings), ...alchemyEnv, PORT: String(port), ...news.env },
            // A replaced sandbox runs nothing yet.
            previous: output?.sandboxId === sandbox.id ? output.program : undefined,
            note: session.note,
          });
          const hosted = yield* boat.hostPort({
            sandboxId: sandbox.id,
            port,
            public: news.public ?? false,
          });
          const parsed = hosted.url === undefined ? undefined : new URL(hosted.url);
          const token = parsed?.searchParams.get("_token") ?? undefined;
          return {
            ...attrs,
            url: parsed?.origin,
            urlToken: token === undefined ? undefined : Redacted.make(token),
            program: state,
          };
        }),
        delete: Effect.fn(function* ({ output }) {
          yield* deleteSandbox(output.sandboxId);
        }),
        // Declared sandboxes and the ones bindings create at run time both
        // carry `alchemy.stack`, so `nuke` finds both.
        list: Effect.fn(function* () {
          const all = yield* Stream.runCollect(boat.listSandboxes.items({ limit: 100 }));
          return Array.from(all)
            .filter(
              (sandbox) => sandbox.state !== "cancelled" && hasAnyAlchemyLabel(sandbox.labels),
            )
            .map(toAttributes);
        }),
      };
    }),
  );
