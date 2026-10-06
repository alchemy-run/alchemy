import * as Effect from "effect/Effect";
import type * as HttpServerRequest from "effect/http/HttpServerRequest";
import type * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Layer from "effect/Layer";
import * as RpcSerialization from "effect/rpc/RpcSerialization";
import * as RpcServer from "effect/rpc/RpcServer";
import * as Scope from "effect/Scope";
import * as Binding from "../Binding.ts";
import type { ImageLayer } from "../Docker/ImageEnvironment.ts";
import type { Resource, ResourceLike } from "../Resource.ts";
import type { RuntimeContext } from "../RuntimeContext.ts";
import { makeHarness, type HarnessDriver } from "./HarnessEngine.ts";
import { SessionError, type Harness } from "./Session.ts";
import { HarnessRpcs, serveHarness } from "./SessionRpcs.ts";
import { MemorySessionStore } from "./SessionStore.ts";

/** Host types a harness server can install itself into (they accept `image` layers). */
const IMAGE_HOSTS = new Set(["Cloudflare.Container"]);

/** A host whose binding contract accepts image layers and env. */
type ImageBindingHost = Resource<
  string,
  object | undefined,
  object,
  { image?: ImageLayer[]; env?: Record<string, unknown> }
>;

const isImageHost = (host: ResourceLike): host is ImageBindingHost => IMAGE_HOSTS.has(host.Type);

export interface HarnessServerOptions<R> {
  /** Binding key on the host (one per harness instance in a box). */
  readonly id: string;
  /** Dockerfile layers that install the harness into the host's image. */
  readonly image?: ReadonlyArray<ImageLayer>;
  /** Environment the harness process needs (credentials, base URLs). */
  readonly env?: Record<string, unknown>;
  /** Build the native driver. Runs only inside the deployed host. */
  readonly driver: Effect.Effect<HarnessDriver, SessionError, R>;
}

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
): Effect.Effect<Harness, SessionError, R> =>
  Effect.gen(function* () {
    if (!globalThis.__ALCHEMY_RUNTIME__) {
      const host = yield* Binding.Host;
      if (host && isImageHost(host)) {
        yield* host.bind`harness:${options.id}`({
          ...(options.image?.length ? { image: [...options.image] } : {}),
          ...(options.env ? { env: options.env } : {}),
        });
      } else if (host) {
        return yield* Effect.die(
          new Error(
            `${options.id}: harness servers install into a container host (${[...IMAGE_HOSTS].join(", ")}), got ${host.Type}`,
          ),
        );
      }
      return deployStub(options.id);
    }
    // The host process owns the harness for its whole life.
    const scope = yield* Scope.make();
    const driver = yield* options.driver;
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
  Effect.Effect<HttpServerResponse.HttpServerResponse, never, HttpServerRequest.HttpServerRequest>,
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
    return Effect.scoped(handler);
  });
