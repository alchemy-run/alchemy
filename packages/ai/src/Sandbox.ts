import type { EgressError, GrantableEgress } from "alchemy/Egress/Gateway";
import type { EgressKind } from "alchemy/Egress/Kind";
import type { Named } from "alchemy/Named";
import * as Output from "alchemy/Output";
import { CurrentRuntimeContext, sanitizeKey, type RuntimeContext } from "alchemy/RuntimeContext";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Effectable from "effect/Effectable";
import type * as HttpClient from "effect/http/HttpClient";
import type { HttpClientError } from "effect/http/HttpClientError";
import type * as HttpClientRequest from "effect/http/HttpClientRequest";
import type * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as Option from "effect/Option";
import type * as Scope from "effect/Scope";
import type * as Sink from "effect/Sink";
import type * as Stream from "effect/Stream";

/**
 * What a sandbox declaration fixes: the sizes `start()` takes, and the
 * egress kinds it accepts.
 */
export interface SandboxSpec {
  /** The names `start({ size })` accepts. Every host maps each one. */
  readonly size: string;
  /**
   * The egress kinds the sandbox accepts (e.g. `GitHub.Egress | Anthropic.Egress`):
   * `start({ egress })` only takes egresses of these kinds, and each host
   * installs their tools (`git`, `gh`) at deploy. Omitted: none.
   */
  readonly egress?: EgressKind<string, never>;
}

/** The size names of a sandbox declaration (or its spec). */
export type SandboxSize<S> =
  S extends Sandbox.Decl<any, infer Spec, any>
    ? Spec["size"]
    : S extends SandboxSpec
      ? S["size"]
      : never;

/** The egress kinds a sandbox declaration (or its spec) accepts. */
export type SandboxKinds<S> =
  S extends Sandbox.Decl<any, infer Spec, any>
    ? SpecKinds<Spec>
    : S extends SandboxSpec
      ? SpecKinds<S>
      : never;

type SpecKinds<Spec> = Spec extends { readonly egress: infer K } ? K : never;

/**
 * An egress a sandbox's `start` / `setEgress` accepts: a value from
 * `yield* SomeGateway`, of one of the kinds the sandbox accepts.
 */
export type SandboxEgress<Kind = any> = GrantableEgress<any, Kind>;

/** A sandbox operation failed on its host. */
export class SandboxError extends Data.TaggedError("SandboxError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

/** What the sandbox may reach: egresses from its gateways, and their grants' lifetime. */
export interface SandboxEgressOptions<Kind = any> {
  /**
   * Egresses from `yield* SomeGateway`, of the kinds the sandbox accepts:
   * their hosts and paths go to their gateways (which add the credentials),
   * with one short-lived grant per gateway, renewed before it expires.
   * Replaces what's stored; omitted, what's stored is kept.
   */
  readonly egress?: ReadonlyArray<SandboxEgress<Kind>>;
  /** Each grant's lifetime. @default "5 minutes" (or what's stored) */
  readonly ttl?: Duration.Input;
}

/** `start()` options: a declared size, plus what the sandbox may reach. */
export interface SandboxStartOptions<
  Size extends string = string,
  Kind = any,
> extends SandboxEgressOptions<Kind> {
  /** One of the declaration's sizes. Applies only when this call starts the sandbox. */
  readonly size: Size;
  /** Whether hosts outside `egress` are reachable. @default false with egress */
  readonly enableInternet?: boolean;
  /** Environment for the sandbox's program. */
  readonly env?: Record<string, string>;
}

/** `exec` options. */
export interface SandboxExecOptions {
  readonly cwd?: string;
  readonly env?: Record<string, string>;
  readonly user?: string;
  /** A pseudo-terminal, optionally with its size. */
  readonly pty?: boolean | { readonly cols?: number; readonly rows?: number };
  /** `"pipe"` for a writable stdin, or a stream to read it from. */
  readonly stdin?: ReadableStream<Uint8Array> | "pipe";
  readonly stdout?: "pipe" | "ignore";
  readonly stderr?: "pipe" | "ignore" | "combined";
}

/** What a finished `exec` printed, and its exit code. */
export interface SandboxExecOutput {
  readonly stdout: ArrayBuffer;
  readonly stderr: ArrayBuffer;
  readonly exitCode: number;
}

/** A process in the sandbox, owned by the scope that called `exec`. */
export interface SandboxProcess {
  readonly pid: number;
  readonly isPty: boolean;
  /** Piped standard input. Completing the sink closes stdin. */
  readonly stdin: Sink.Sink<void, Uint8Array, never, SandboxError, RuntimeContext> | undefined;
  /** Piped standard output. Consume this or call output(), not both. */
  readonly stdout: Stream.Stream<Uint8Array, SandboxError, RuntimeContext> | undefined;
  /** Standard error, absent when ignored or combined with stdout. */
  readonly stderr: Stream.Stream<Uint8Array, SandboxError, RuntimeContext> | undefined;
  /** Wait for completion. Nonzero exit codes are returned normally. */
  readonly exitCode: Effect.Effect<number, SandboxError, RuntimeContext>;
  /** Collect output once. */
  output(): Effect.Effect<SandboxExecOutput, SandboxError, RuntimeContext>;
  /** Signal this process (SIGTERM by default). */
  kill(signal?: number): Effect.Effect<void, SandboxError, RuntimeContext>;
  /** Resize the process's pseudo-terminal. */
  resize(cols: number, rows: number): Effect.Effect<void, SandboxError, RuntimeContext>;
}

/** A port inside the sandbox. Requests wait until it accepts connections. */
export interface SandboxPort {
  fetch(
    request: HttpClientRequest.HttpClientRequest,
  ): Effect.Effect<
    HttpClientResponse.HttpClientResponse,
    SandboxError | HttpClientError,
    RuntimeContext
  >;
}

/**
 * The sandbox a Durable Object owns — what `yield* Sandbox` returns. The same
 * on every host. Yielding never starts the sandbox: call {@link start} at
 * the top of each operation (a no-op while it runs).
 */
export interface SandboxClient<Size extends string = string, Kind = any> {
  /** Whether the sandbox is running. */
  readonly running: Effect.Effect<boolean, SandboxError, RuntimeContext>;
  /**
   * Start the sandbox at a declared size unless it is already running, and
   * apply its egress: `egress` and `ttl` replace what's stored (omitted,
   * what's stored is re-applied). Two egresses that claim the same requests
   * fail with `EgressRouteConflict` before anything is stored.
   */
  start(
    options: SandboxStartOptions<Size, Kind>,
  ): Effect.Effect<void, SandboxError | EgressError, RuntimeContext>;
  /**
   * Replace the sandbox's egress (omitted fields are kept): stored, and
   * applied at once to a running sandbox, open connections included.
   */
  setEgress(
    options: SandboxEgressOptions<Kind>,
  ): Effect.Effect<void, SandboxError | EgressError, RuntimeContext>;
  /**
   * Run an argument vector (no shell) in the running sandbox. Closing the
   * scope kills the process.
   */
  exec(
    cmd: ReadonlyArray<string>,
    options?: SandboxExecOptions,
  ): Effect.Effect<SandboxProcess, SandboxError, RuntimeContext | Scope.Scope>;
  /** A port inside the sandbox. */
  getTcpPort(port: number): Effect.Effect<SandboxPort, never, RuntimeContext>;
  /**
   * An `HttpClient` for a port inside the sandbox, e.g. for
   * `AI.connectHarness` to a harness server on port 3000.
   */
  httpClient(port: number): Effect.Effect<HttpClient.HttpClient, never, RuntimeContext>;
  /** Stop the sandbox now. Its routes are cleared first; the stored egress stays for the next `start`. */
  stop(): Effect.Effect<void, SandboxError, RuntimeContext>;
}

/**
 * @internal What a host binds for a declaration, read by the owning Durable
 * Object at run time: which host serves it, and each size's host value.
 */
export interface SandboxHostDescriptor {
  readonly host: string;
  readonly sizes: Record<string, unknown>;
  /** A MicroVM host's egress network connector ARN (an Output until deploy). */
  readonly networkConnector?: string | Output.Output<string>;
}

/**
 * @internal The host of one sandbox declaration, provided by its host
 * constructor (e.g. `Cloudflare.Containers.Sandbox`) at deploy time.
 */
export interface SandboxHostService {
  readonly descriptor: SandboxHostDescriptor;
  /** The host's image resource: harnesses bind env and image layers into it. */
  readonly image: Effect.Effect<unknown, never, any>;
  /** Deploy time: install the tools the accepted egress kinds need (`git`, `gh`). */
  readonly install: (
    kinds: ReadonlyArray<EgressKind<string, never>>,
  ) => Effect.Effect<void, never, any>;
}

/**
 * @internal Connects a declaration to its host from inside the Durable
 * Object that owns it. Provided by the Durable Object platform.
 */
export class SandboxRuntime extends Context.Service<
  SandboxRuntime,
  {
    readonly connect: (
      id: string,
      descriptor: SandboxHostDescriptor,
    ) => Effect.Effect<SandboxClient, never, any>;
  }
>()("alchemy/AI/SandboxRuntime") {}

/** @internal The service a host constructor provides for declaration `id`. */
export const sandboxHost = (id: string) =>
  Context.Service<Sandbox.Host<unknown>, SandboxHostService>(`alchemy/AI/Sandbox<${id}>`);

/**
 * The declaration's second argument: the accepted egress kinds as values
 * (they carry the tools each host installs). Required, and only allowed,
 * when the spec declares `egress`.
 */
export type SandboxDeclarationArgs<Kinds> = [Kinds] extends [never]
  ? []
  : [options: { readonly egress: ReadonlyArray<Kinds> }];

/** @internal Marks a sandbox declaration. */
export const SandboxTypeId = "~alchemy/AI/Sandbox" as const;

export const isSandbox = (value: unknown): value is Sandbox.Decl.Any =>
  (typeof value === "function" || typeof value === "object") &&
  value !== null &&
  SandboxTypeId in value;

const descriptorKey = (id: string) => sanitizeKey(`ALCHEMY_SANDBOX_${id}`);

const connect = (id: string, kinds: ReadonlyArray<EgressKind<string, never>>) =>
  Effect.gen(function* () {
    const runtime = yield* Effect.serviceOption(SandboxRuntime);
    if (Option.isNone(runtime)) {
      return yield* Effect.die(
        new SandboxError({
          message: `Sandbox '${id}' can only be yielded inside the Durable Object that owns it.`,
        }),
      );
    }
    const host = yield* Effect.serviceOption(sandboxHost(id));
    const ctx = yield* CurrentRuntimeContext;
    let descriptor: SandboxHostDescriptor | undefined;
    if (Option.isSome(host)) {
      descriptor = host.value.descriptor;
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        // The accepted kinds' tools go into the host's image.
        if (kinds.length > 0) yield* host.value.install(kinds);
        // The owning Worker carries the host's descriptor to run time.
        if (ctx) {
          const bound: SandboxHostDescriptor = descriptor;
          const { networkConnector } = bound;
          yield* ctx.set(
            descriptorKey(id),
            Output.isOutput(networkConnector)
              ? networkConnector.pipe(
                  Output.map((arn): SandboxHostDescriptor => ({ ...bound, networkConnector: arn })),
                )
              : Output.literal(bound),
          );
        }
      }
    } else if (ctx) {
      descriptor = yield* ctx.get<SandboxHostDescriptor>(descriptorKey(id));
    }
    if (descriptor === undefined) {
      return yield* Effect.die(
        new SandboxError({
          message: `Sandbox '${id}' has no host: provide one (e.g. Cloudflare.Containers.Sandbox(${id}, …)) on the stack.`,
        }),
      );
    }
    return yield* runtime.value.connect(id, descriptor);
  });

/**
 * A sandbox declaration: the shape a Durable Object uses to run a program in
 * an isolated machine (`start`, `exec`, `setEgress`, `stop`), with the sizes
 * it can start at. It says nothing about where it runs: a host constructor
 * (`Cloudflare.Containers.Sandbox`) provides it, with the image, the program,
 * and what each size means on that host.
 *
 * Declare it in its own file so the Durable Object that yields it never
 * bundles the program.
 *
 * ### Declaring a sandbox
 * **Example:** Two sizes
 * ```typescript
 * // src/Sandbox.ts
 * import * as AI from "@alchemy.run/ai";
 *
 * export class Sandbox extends AI.Sandbox<Sandbox, { size: "small" | "large" }>()(
 *   "Sandbox",
 * ) {}
 * ```
 *
 * ### Accepting egress kinds
 * A sandbox holds no credentials: its requests to egress hosts go to an
 * egress gateway (`Egress.Gateway`), which adds them. The declaration names
 * the egress kinds it accepts, in its type and as values: each host installs
 * their tools at deploy (`git` and `gh` for `GitHub.Egress`), and `start`
 * only takes egresses of these kinds.
 *
 * **Example:** A sandbox for GitHub and the model
 * ```typescript
 * import * as AI from "@alchemy.run/ai";
 * import * as Anthropic from "@alchemy.run/anthropic";
 * import * as GitHub from "@alchemy.run/github";
 *
 * export class Sandbox extends AI.Sandbox<
 *   Sandbox,
 *   { size: "small" | "large"; egress: GitHub.Egress | Anthropic.Egress }
 * >()("Sandbox", { egress: [GitHub.Egress, Anthropic.Egress] }) {}
 * ```
 *
 * ### Hosting it
 * A host constructor takes the declaration, the host's props, and the
 * program, and maps every declared size. A missing or extra size name does
 * not compile.
 *
 * **Example:** Claude Code on a Cloudflare Container
 * ```typescript
 * // src/Sandbox.cloudflare.ts
 * import * as Anthropic from "@alchemy.run/anthropic";
 * import * as Cloudflare from "@alchemy.run/cloudflare";
 * import { Sandbox } from "./Sandbox.ts";
 *
 * export default Cloudflare.Containers.Sandbox(
 *   Sandbox,
 *   {
 *     main: import.meta.url,
 *     runtime: "node",
 *     image: "node:24-bookworm",
 *     sizes: { small: "lite", large: "standard-4" },
 *   },
 *   Anthropic.ClaudeCodeServer("Claude", { cwd: "/workspace/app" }),
 * );
 * ```
 *
 * ### Using it from a Durable Object
 * `yield* Sandbox` returns the {@link SandboxClient}. `start({ size })` only
 * takes declared sizes.
 *
 * **Example:** Start, run a command, stop
 * ```typescript
 * export class Agent extends Cloudflare.DurableObject<Agent>()(
 *   "Agent",
 *   Effect.gen(function* () {
 *     const sandbox = yield* Sandbox;
 *     return Effect.gen(function* () {
 *       return {
 *         run: (cmd: string[]) =>
 *           sandbox.start({ size: "large", enableInternet: true }).pipe(
 *             Effect.andThen(sandbox.exec(cmd)),
 *             Effect.flatMap((process) => process.output()),
 *             Effect.scoped,
 *           ),
 *         stop: () => sandbox.stop(),
 *       };
 *     });
 *   }),
 * ) {}
 * ```
 *
 * **Example:** Granting egresses from two gateways
 * ```typescript
 * export class Agent extends Cloudflare.DurableObject<Agent>()(
 *   "Agent",
 *   Effect.gen(function* () {
 *     const sandbox = yield* Sandbox;
 *     const work = yield* WorkGateway; // { model, repo }
 *     const personal = yield* PersonalGateway; // { repo }
 *     return Effect.gen(function* () {
 *       return {
 *         work: (issue: number) =>
 *           sandbox.start({
 *             size: "large",
 *             egress: [
 *               work.model,
 *               work.repo.narrow({ repository: "alchemy-run/alchemy", issue }),
 *               personal.repo.narrow({ repository: "sam/dotfiles", graphql: false }),
 *             ],
 *             ttl: "5 minutes",
 *           }),
 *         // Applies at once, on open connections too.
 *         modelOnly: () => sandbox.setEgress({ egress: [work.model] }),
 *         settle: () => sandbox.stop(),
 *       };
 *     });
 *   }),
 * ) {}
 * ```
 *
 * **Example:** Connecting to the harness server it runs
 * ```typescript
 * const claude = yield* sandbox
 *   .start({ size: "small" })
 *   .pipe(
 *     Effect.andThen(sandbox.httpClient(3000)),
 *     Effect.flatMap((client) => AI.connectHarness(client)),
 *   );
 * ```
 *
 * ### Providing the host
 * The host is a Layer: provide it on the stack, like any other
 * implementation. Without it `yield* Sandbox` stays unsatisfied and the stack
 * does not type-check.
 *
 * **Example:** Wiring the host into the stack
 * ```typescript
 * // alchemy.run.ts
 * import SandboxLive from "./src/Sandbox.cloudflare.ts";
 *
 * export default Alchemy.Stack(
 *   "App",
 *   { providers: Cloudflare.providers(), state: Cloudflare.state() },
 *   Effect.gen(function* () {
 *     const api = yield* Api;
 *     return { url: api.url };
 *   }).pipe(Effect.provide(SandboxLive)),
 * );
 * ```
 *
 * @binding
 * @product AI
 * @category AI
 */
export const Sandbox =
  <Self, Spec extends SandboxSpec>() =>
  <const Id extends string>(
    id: Id,
    ...options: SandboxDeclarationArgs<SpecKinds<Spec>>
  ): Sandbox.Decl<Self, Spec, Id> => {
    const host = sandboxHost(id);
    const kinds = (options[0]?.egress ?? []) as ReadonlyArray<EgressKind<string, never>>;
    return Object.assign(
      class {},
      Effectable.Prototype({
        label: `AI.Sandbox<${id}>`,
        evaluate: () => connect(id, kinds),
      }),
      {
        [SandboxTypeId]: SandboxTypeId,
        "~alchemy/Id": id,
        LogicalId: id,
        egress: kinds,
        // Deploy time: the host's image, for egresses and harnesses to bind into.
        Application: Effect.flatMap(Effect.serviceOption(host), (provided) =>
          Option.isSome(provided)
            ? provided.value.image
            : Effect.die(new SandboxError({ message: `Sandbox '${id}' has no host.` })),
        ),
      },
    ) as unknown as Sandbox.Decl<Self, Spec, Id>;
  };

export declare namespace Sandbox {
  /** The service a host constructor's Layer provides for declaration `Self`. */
  export interface Host<Self> {
    readonly "~alchemy/SandboxHost": Self;
  }

  export interface Decl<
    Self = any,
    Spec extends SandboxSpec = SandboxSpec,
    Id extends string = string,
  >
    extends
      Effect.Effect<SandboxClient<Spec["size"], SpecKinds<Spec>>, never, Host<Self>>,
      Named<Id> {
    new (_: never): SandboxClient<Spec["size"], SpecKinds<Spec>>;
    readonly [SandboxTypeId]: typeof SandboxTypeId;
    readonly LogicalId: Id;
    /** The egress kinds it accepts, as values: their tools are installed at deploy. */
    readonly egress: ReadonlyArray<EgressKind<string, never>>;
    /** @internal phantom: the declaration's spec. */
    readonly "~alchemy/SandboxSpec"?: Spec;
    /** @internal Deploy time: the host's image resource. */
    readonly Application: Effect.Effect<unknown>;
  }
  export namespace Decl {
    export type Any = Decl<any, any, string>;
  }
}
