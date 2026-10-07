import type * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Layer from "effect/Layer";
import type * as Path from "effect/Path";
import type { ChildProcessSpawner } from "effect/process/ChildProcessSpawner";
import * as Redacted from "effect/Redacted";
import * as RpcSerialization from "effect/rpc/RpcSerialization";
import * as RpcServer from "effect/rpc/RpcServer";
import * as Scope from "effect/Scope";
import { bindIntoImageHost } from "../Docker/ImageHost.ts";
import type { ImageLayer } from "../Docker/ImageLayer.ts";
import { gitCliLayer } from "../FS/GitMount.ts";
import { unpackEnvValue, type RuntimeContext } from "../RuntimeContext.ts";
import { makeHarness, type HarnessDriver } from "./HarnessEngine.ts";
import { prewarmWorkspaces, sessionCwd } from "./LocalWorkspace.ts";
import { SessionError, type Harness } from "./Session.ts";
import { HarnessRpcs, serveHarness } from "./SessionRpcs.ts";
import { MemorySessionStore } from "./SessionStore.ts";

/** Where sessions work when neither the server nor the session names a directory. */
export const DEFAULT_CWD = "/workspace";

export interface HarnessServerOptions<R> {
  /** Binding key on the host (one per harness instance in a box). */
  readonly id: string;
  /** Default working directory; created in the image if no environment provides it. */
  readonly cwd?: string;
  /** Dockerfile layers that install the harness into the host's image. */
  readonly image?: ReadonlyArray<ImageLayer>;
  /** Environment the harness process needs (credentials, base URLs). */
  readonly env?: Record<string, unknown>;
  /**
   * Build the native driver. Runs only inside the deployed host, in a scope
   * that lives as long as the host process (long-lived agent connections).
   */
  readonly driver: Effect.Effect<HarnessDriver, SessionError, R | Scope.Scope>;
}

/**
 * An image layer that installs npm packages — globally (CLIs on `PATH`) or
 * into `/app` (libraries the bundled program imports at runtime). Uses `npm`
 * when the base image has it, `bun` otherwise.
 */
export const npmInstallLayer = (
  id: string,
  packages: ReadonlyArray<string>,
  options: { readonly into?: "global" | "app" } = {},
): ImageLayer => {
  const pkgs = packages.join(" ");
  return {
    id,
    npm: { packages, into: options.into ?? "global" },
    instructions:
      options.into === "app"
        ? `RUN mkdir -p /app && cd /app && if command -v npm >/dev/null 2>&1; then npm install --no-save --no-package-lock ${pkgs}; else bun add ${pkgs}; fi`
        : `RUN if command -v npm >/dev/null 2>&1; then npm install -g ${pkgs}; else bun add -g ${pkgs}; fi`,
  };
};

/**
 * An image layer that installs system packages with whichever package
 * manager the base image has (`apt-get` or `apk`); a no-op on images with
 * neither.
 */
export const systemPackagesLayer = (id: string, packages: ReadonlyArray<string>): ImageLayer => {
  const pkgs = packages.join(" ");
  return {
    id,
    stage: "setup",
    instructions: `RUN if command -v apt-get >/dev/null 2>&1; then apt-get update && apt-get install -y --no-install-recommends ${pkgs} && rm -rf /var/lib/apt/lists/*; elif command -v apk >/dev/null 2>&1; then apk add --no-cache ${pkgs}; fi`,
  };
};

const unavailable = (name: string) =>
  Effect.die(
    new Error(
      `${name} runs inside its host (a container); it is not available at deploy time or outside the host.`,
    ),
  );

/** A stand-in harness for the deploy pass, where no process can be spawned. */
const deployStub = (name: string): Harness => ({
  name,
  capabilities: {
    steering: "interrupt-restart",
    queuedPrompts: false,
    fork: false,
    rollback: false,
    subagents: false,
    plans: false,
    reasoning: false,
    modelSwitching: false,
  },
  start: () => unavailable(name),
  get: () => unavailable(name),
  list: () => unavailable(name),
});

/**
 * The shared shape of every harness server (`Anthropic.ClaudeCodeServer`,
 * `OpenAI.CodexServer`, `AI.AcpServer`, …): a binding that installs a
 * coding-agent harness into the host it is yielded in, and runs it there.
 *
 * - **Deploy**: binds `{ image, env }` onto the host (`Binding.Host`), so the
 *   harness CLI is baked into the host's image and its credentials land in
 *   the host's environment.
 * - **Runtime** (inside the deployed host): builds the native driver and
 *   wraps it with the shared engine ({@link makeHarness}). Sessions and their
 *   event log live for the life of the host process.
 */
export const makeHarnessServer = <R>(
  options: HarnessServerOptions<R>,
): Effect.Effect<Harness, never, Exclude<R, Scope.Scope>> =>
  Effect.gen(function* () {
    if (!globalThis.__ALCHEMY_RUNTIME__) {
      yield* bindIntoImageHost(`harness:${options.id}`, {
        image: [
          gitCliLayer,
          ...(options.cwd
            ? [
                {
                  id: `workdir:${options.cwd}`,
                  stage: "setup" as const,
                  instructions: `RUN mkdir -p ${JSON.stringify(options.cwd)}`,
                },
              ]
            : []),
          ...(options.image ?? []),
        ],
        ...(options.env ? { env: options.env } : {}),
      });
      return deployStub(options.id);
    }
    // Bound env values travel packed (Redacted markers, JSON) for Alchemy's
    // own accessors; the harness CLI reads raw `process.env`, so unpack them.
    for (const key of Object.keys(options.env ?? {})) {
      const value = unpackEnvValue<unknown>(process.env[key]);
      if (value === undefined) continue;
      process.env[key] = Redacted.isRedacted(value)
        ? String(Redacted.value(value))
        : typeof value === "string"
          ? value
          : JSON.stringify(value);
    }
    // The host process owns the harness for its whole life.
    const scope = yield* Scope.make();
    // A harness that can't start leaves its host nothing to serve: a defect.
    const native = yield* options.driver.pipe(
      Effect.provideService(Scope.Scope, scope),
      Effect.orDie,
    );
    // On this machine (`AI.LocalHarness`) one process serves every session:
    // each session's working directory maps into its own worktree. In a
    // container the path is used as is. The bootstrap's platform services
    // (file system, process spawning) do the work.
    const platform = (yield* Effect.context<never>()) as Context.Context<
      FileSystem.FileSystem | Path.Path | ChildProcessSpawner
    >;
    // Have a worktree ready before the first session asks for one.
    yield* prewarmWorkspaces.pipe(Effect.provideContext(platform));
    const driver: HarnessDriver = {
      ...native,
      open: (session) =>
        sessionCwd(session.cwd, session.id).pipe(
          Effect.provideContext(platform),
          Effect.flatMap((cwd) => native.open({ ...session, cwd })),
        ),
    };
    const store = yield* Layer.build(MemorySessionStore).pipe(Scope.provide(scope));
    return yield* makeHarness(driver).pipe(
      Effect.provideContext(store),
      Effect.provideService(Scope.Scope, scope),
    );
  });

/**
 * Serve a harness over HTTP as {@link HarnessRpcs} (NDJSON, streaming
 * events). Use it as a container's `fetch` so code outside the sandbox (a
 * Durable Object, a Worker) can drive the harness with `AI.remoteHarness`.
 */
export const serveHarnessHttp = (
  harness: Harness,
): Effect.Effect<
  Effect.Effect<
    HttpServerResponse.HttpServerResponse,
    never,
    HttpServerRequest.HttpServerRequest | Scope.Scope
  >,
  never,
  RuntimeContext
> =>
  Effect.gen(function* () {
    const scope = yield* Scope.make();
    const handlers = yield* Layer.build(serveHarness(harness)).pipe(Scope.provide(scope));
    const handler = yield* RpcServer.toHttpEffect(HarnessRpcs).pipe(
      Effect.provide(Layer.mergeAll(Layer.succeedContext(handlers), RpcSerialization.layerNdjson)),
      Effect.provideService(Scope.Scope, scope),
    );
    // Only POSTs are RPC calls; everything else (container readiness probes,
    // health checks) gets a plain 200. RPC responses stream (`events`), so
    // they run in the server's request scope, which stays open until the
    // body is fully written — never a scope closed when the handler returns.
    return Effect.flatMap(HttpServerRequest.HttpServerRequest, (request) =>
      request.method === "POST" ? handler : Effect.succeed(HttpServerResponse.text("ok")),
    );
  });
