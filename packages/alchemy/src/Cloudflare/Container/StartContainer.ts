import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import { ALCHEMY_PHASE } from "../../Phase.ts";
import { makeFetchRpcStub } from "../../Rpc.ts";
import { type Fetcher } from "../Fetcher.ts";
import {
  ContainerError,
  ContainerTag,
  type Container,
  type ContainerStartupOptions,
} from "./Container.ts";

export const layerContainer = <Image extends Container.Decl.Any>(
  container: Image,
  options?: ContainerStartupOptions,
) => {
  const id = (container as any)["~alchemy/Id"] as string;
  // Provide the *started* instance under the same tag `yield* MyContainer`
  // resolves (keyed by logical id) so the two compose.
  return Layer.effect(
    ContainerTag(id),
    startContainer(container, options),
  ) as Layer.Layer<InstanceType<Image>>;
};

/**
 * Runs the Container in a Durable Object and monitors it, providing a durable fetch and RPC interface to it.
 */
export const startContainer = Effect.fn(function* <
  Image extends Container.Decl.Any,
>(containerEff: Image, options?: ContainerStartupOptions) {
  const bindEff = (containerEff as any)["~alchemy/Container/Binding"] as
    | Effect.Effect<Effect.Effect<Container>, never, any>
    | undefined;
  const bound = yield* (
    bindEff ?? (containerEff as any as Effect.Effect<any, never, never>)
  );
  const container: Container = Effect.isEffect(bound)
    ? yield* bound as Effect.Effect<Container>
    : (bound as Container);

  const ensureRunning = Effect.gen(function* () {
    if (yield* container.running) return;
    yield* Effect.logInfo("Container not running, starting...");
    yield* container.start(options);
    yield* Effect.logInfo("Container started, launching monitor");
    yield* Effect.forkDetach(
      container.monitor().pipe(
        Effect.flatMap(() => Effect.logInfo("Container monitor exited")),
        Effect.catchTag("ContainerError", (error) =>
          Effect.logError(`Container monitor error: ${error.message}`),
        ),
      ),
    );
  });

  // Poll the container roughly every 2–3s while it cold-starts, but bound the
  // total wait (~3 min) so an unreachable container surfaces a `ContainerError`
  // instead of hanging the Durable Object request forever. Without this cap a
  // container that never accepts connections on the requested port (e.g. it
  // crash-loops, or the process never binds the port) would retry indefinitely
  // and the worker request would never return.
  const startupBackoff = Schedule.exponential(100, 1.5).pipe(
    Schedule.modifyDelay((_, delay) =>
      Effect.succeed(
        Duration.min(
          Duration.max(delay, Duration.seconds(1)),
          Duration.seconds(3),
        ),
      ),
    ),
    Schedule.both(Schedule.recurs(75)),
  );

  const getTcpPort = (portNumber: number) =>
    Effect.succeed({
      fetch: ((
        request:
          | HttpClientRequest.HttpClientRequest
          | HttpServerRequest.HttpServerRequest,
      ) =>
        ensureRunning.pipe(
          Effect.andThen(() => container.getTcpPort(portNumber)),
          Effect.andThen((port: Fetcher) => port.fetch(request as any)),
          Effect.catchDefect((defect: unknown) =>
            Effect.fail(
              new ContainerError({
                message: `Container not ready on port ${portNumber}: ${defect}`,
              }),
            ),
          ),
          Effect.tapError((err) =>
            Effect.logDebug(`Container fetch error (will retry): ${err}`),
          ),
          Effect.retry({ schedule: startupBackoff }),
        )) as {
        (
          request: HttpClientRequest.HttpClientRequest,
        ): Effect.Effect<HttpClientResponse.HttpClientResponse>;
        (
          request: HttpServerRequest.HttpServerRequest,
        ): Effect.Effect<HttpServerResponse.HttpServerResponse>;
      },
    });

  const phase = yield* ALCHEMY_PHASE;

  // eagerly start the container when in runtime, no-op during planning
  if (phase === "runtime") {
    // erase the RuntimeContext color (we are applying it eagerly as an optimization only during runtime)
    yield* ensureRunning as Effect.Effect<void>;
  }

  // The container exposes its non-`fetch` shape methods (declared on the
  // Container class) over the plain-`fetch` RPC protocol served by the
  // container runtime (`serveRpc`). Wrap the instance so that any method that
  // isn't one of the built-in handle methods (`running`/`start`/`getTcpPort`/…)
  // is dispatched as `POST http://container/__rpc__/{name}` over the
  // container's port-3000 server.
  const base = {
    ...container,
    getTcpPort,
    fetch: getTcpPort(3000),
  };
  return makeFetchRpcStub<Container.Instance<InstanceType<Image>>>({
    fetch: (request) =>
      getTcpPort(3000).pipe(Effect.flatMap((port) => port.fetch(request))),
    baseUrl: "http://container",
    base: base as Record<string, unknown>,
  });
});
