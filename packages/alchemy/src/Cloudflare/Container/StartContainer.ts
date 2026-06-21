import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import { type Fetcher } from "../Fetcher.ts";
import {
  type Container,
  ContainerError,
  type ContainerStartupOptions,
} from "./Container.ts";

export declare const layerContainer: {
  <Image extends Container.Decl>(
    container: Image,
    options?: ContainerStartupOptions,
  ): Layer.Layer<InstanceType<Image>>;
};

/**
 * Runs the Container in a Durable Object and monitors it, providing a durable fetch and RPC interface to it.
 */
export const startContainer = Effect.fnUntraced(function* <
  Image extends Container.Decl,
>(containerEff: Image, options?: ContainerStartupOptions) {
  const container: Container = yield* containerEff;

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

  yield* ensureRunning;

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

  return {
    ...container,
    getTcpPort,
    fetch: getTcpPort(3000),
  } as Container.Instance<InstanceType<Image>>;
});
