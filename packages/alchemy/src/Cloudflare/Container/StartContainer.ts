import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import { type Fetcher } from "../Fetcher.ts";
import { DurableObjectState } from "../Workers/DurableObjectState.ts";
import { WorkerEnvironment } from "../Workers/Worker.ts";
import { type Container, ContainerError } from "./Container.ts";

/**
 * Runs the Container in a Durable Object and monitors it, providing a durable fetch and RPC interface to it.
 */
export const start = Effect.fnUntraced(function* <
  Shape extends Container,
  Req = never,
>(containerEff: Effect.Effect<Shape, never, Req | DurableObjectState>) {
  const container = yield* containerEff;

  const ensureRunning = Effect.gen(function* () {
    if (yield* container.running) return;
    yield* Effect.logInfo("Container not running, starting...");
    // Forward string-valued env secrets from the Worker to the container so
    // bun can read them via `Bun.env.XXX` at runtime. CF Firecracker VMs are
    // hermetic — they don't inherit the Worker's env unless passed explicitly
    // through ContainerStartupOptions.env.
    const workerEnvOpt = yield* Effect.serviceOption(WorkerEnvironment);
    const env: Record<string, string> = {};
    if (workerEnvOpt._tag === "Some") {
      for (const [key, value] of Object.entries(workerEnvOpt.value as Record<string, unknown>)) {
        if (typeof value === "string") env[key] = value;
      }
    }
    // CF Containers default to BLOCKED public egress. Containers get only
    // private addresses (10.0.0.1/24 + fd00::11) on cfeth0 and every DNS
    // lookup / TCP connect / fetch hangs indefinitely unless enableInternet
    // is explicitly set.
    //
    // Opt in by setting ALCHEMY_CONTAINER_ENABLE_INTERNET=1 in the Worker
    // env (or as a secret). We log a one-line hint on first start when the
    // flag is absent, so users hitting the DNS-hang symptom can find the
    // fix in logs instead of debugging Firecracker networking blind.
    const enableInternet = env.ALCHEMY_CONTAINER_ENABLE_INTERNET === "1";
    if (!enableInternet) {
      yield* Effect.logInfo(
        "Container starting with public egress DISABLED. Set ALCHEMY_CONTAINER_ENABLE_INTERNET=1 in the Worker env to enable internet access (cfeth0 has only private addresses by default).",
      );
    }
    yield* container.start({ enableInternet, env });
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

  const startupBackoff = Schedule.exponential(100, 1.5).pipe(
    Schedule.modifyDelay((_, delay) =>
      Effect.succeed(Duration.max(delay, Duration.seconds(2))),
    ),
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
  };
});
