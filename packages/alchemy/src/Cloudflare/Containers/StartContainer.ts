import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import * as Semaphore from "effect/Semaphore";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import { ALCHEMY_PHASE } from "../../Phase.ts";
import { makeFetchRpcStub } from "../../Rpc.ts";
import { type Fetcher } from "../Fetcher.ts";
import {
  ContainerCrashedError,
  ContainerError,
  ContainerRateLimitedError,
  ContainerTag,
  NoContainerInstanceError,
  type Container,
  type ContainerStartupOptions,
} from "./Container.ts";

export const layer = <Image extends Container.Decl.Any>(
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

  // Every constant below is taken directly from Cloudflare's own
  // `@cloudflare/containers` runtime (`dist/lib/container.js`) rather than
  // guessed, so our readiness behaviour matches `startAndWaitForPorts`:
  //
  //   INSTANCE_POLL_INTERVAL_MS  = 300    → fixed poll interval
  //   PING_TIMEOUT_MS            = 5_000  → per-probe cap (addTimeoutSignal)
  //   TIMEOUT_TO_GET_CONTAINER_MS = 8_000 → phase 1: find+start an instance
  //   TIMEOUT_TO_GET_PORTS_MS    = 20_000 → phase 2: wait for the port to listen
  //
  // Native derives its retry COUNTS as ceil(timeout / pollInterval); we keep
  // the two phases separate (as native does) on a 300ms cadence.
  const READINESS_POLL_INTERVAL = Duration.millis(300); // INSTANCE_POLL_INTERVAL_MS
  const READINESS_PROBE_TIMEOUT = Duration.seconds(5); // PING_TIMEOUT_MS
  const TIMEOUT_TO_GET_CONTAINER_MS = 8_000;
  const TIMEOUT_TO_GET_PORTS_MS = 20_000;
  const GET_CONTAINER_RETRIES = Math.ceil(TIMEOUT_TO_GET_CONTAINER_MS / 300); // 27
  const PORT_READY_RETRIES = Math.ceil(TIMEOUT_TO_GET_PORTS_MS / 300); // 67
  // When rate limited, back off hard before retrying — hammering `start()`
  // only prolongs the limit (native returns 429 immediately and does not loop).
  const RATE_LIMIT_BACKOFF = Duration.seconds(2);
  const RATE_LIMIT_RETRIES = 5;
  // Light retry for the real request only — covers the transient
  // "Network connection lost" window when a container instance is recycled.
  const REQUEST_RETRIES = 3;

  // Error classification, mirroring native's string matchers in
  // `@cloudflare/containers` (`isErrorOfType` against these exact phrases).
  const errString = (e: unknown) =>
    (e instanceof Error ? e.message : String(e)).toLowerCase();
  const isNoInstanceError = (e: unknown) =>
    errString(e).includes(
      "there is no container instance that can be provided to this durable object",
    );
  const isRateLimitedError = (e: unknown) =>
    errString(e).includes("you are requesting too many containers per second");

  type ReadinessError =
    | ContainerError
    | NoContainerInstanceError
    | ContainerRateLimitedError
    | ContainerCrashedError;

  // Map a raw defect to a typed readiness error (native classifies the same
  // message phrases via `isErrorOfType`).
  const classifyDefect = (
    defect: unknown,
    portNumber: number,
  ): ContainerError | NoContainerInstanceError | ContainerRateLimitedError =>
    isRateLimitedError(defect)
      ? new ContainerRateLimitedError({
          message: "Rate limited starting container",
          cause: defect,
        })
      : isNoInstanceError(defect)
        ? new NoContainerInstanceError({
            message: "No container instance available",
            cause: defect,
          })
        : new ContainerError({
            message: `Container not ready on port ${portNumber}: ${defect}`,
            cause: defect,
          });

  // Coalesce concurrent starts. Native uses a `startInFlight` promise so two
  // racing callers never both invoke `container.start()` (which throws
  // "already running" — see cloudflare/containers#173). A 1-permit semaphore
  // serialises the start path; the second entrant sees `running === true` and
  // skips, so `start()` is issued exactly once.
  const startMutex = Semaphore.makeUnsafe(1);

  // Ports already confirmed listening on this instance. Once a port has
  // answered we skip the readiness probe entirely (like native's `healthy`
  // state), so steady-state requests pay no polling cost.
  const readyPorts = new Set<number>();

  const launchMonitor = Effect.forkDetach(
    container.monitor().pipe(
      Effect.flatMap(() => Effect.logInfo("Container monitor exited")),
      Effect.catchTag("ContainerError", (error) =>
        Effect.logError(`Container monitor error: ${error.message}`),
      ),
    ),
  );

  // Start the container if it isn't running, serialised + classified. Backs
  // off on rate limiting instead of hammering the allocator.
  const ensureRunning = Semaphore.withPermits(
    startMutex,
    1,
  )(
    Effect.gen(function* () {
      if (yield* container.running) return;
      yield* Effect.logDebug("Container not running, starting...");
      yield* container.start(options).pipe(
        Effect.catchDefect((defect) => Effect.fail(classifyDefect(defect, -1))),
        // A rate limit is transient — back off well clear of the per-second
        // window and try again a few times before surfacing it.
        Effect.retry({
          while: (
            e:
              | ContainerError
              | NoContainerInstanceError
              | ContainerRateLimitedError,
          ) => e._tag === "ContainerRateLimitedError",
          schedule: Schedule.spaced(RATE_LIMIT_BACKOFF),
          times: RATE_LIMIT_RETRIES,
        }),
      );
      yield* launchMonitor;
    }),
  );

  // A single readiness probe: any response at all (even a non-2xx) proves the
  // port is accepting connections. Each probe is hard-capped so a hung connect
  // to a not-yet-bound port cannot stall the request. If the instance has gone
  // away (`running === false`) after we started it, surface a crash rather than
  // polling out the whole budget (native's `if (!this.container.running)`).
  const probePort = (portNumber: number) =>
    container.getTcpPort(portNumber).pipe(
      Effect.andThen((port: Fetcher) =>
        port.fetch(
          HttpClientRequest.get("http://containerstarthealthcheck") as any,
        ),
      ),
      Effect.timeout(READINESS_PROBE_TIMEOUT),
      Effect.catchDefect((defect: unknown) =>
        container.running.pipe(
          Effect.andThen((running) =>
            Effect.fail<ReadinessError>(
              !running &&
                !isRateLimitedError(defect) &&
                !isNoInstanceError(defect)
                ? new ContainerCrashedError({
                    message: `Container exited while waiting for port ${portNumber}`,
                    cause: defect,
                  })
                : classifyDefect(defect, portNumber),
            ),
          ),
        ),
      ),
      // A probe that hangs past the per-attempt cap, or fails the HTTP fetch
      // before the port is up, is just "not ready yet" — retry it like any
      // other transient readiness failure.
      Effect.catchTag(["TimeoutError", "HttpClientError"], (cause: unknown) =>
        container.running.pipe(
          Effect.andThen((running) =>
            Effect.fail<ReadinessError>(
              !running
                ? new ContainerCrashedError({
                    message: `Container exited while waiting for port ${portNumber}`,
                    cause,
                  })
                : new ContainerError({
                    message: `Container probe not ready on port ${portNumber}`,
                    cause,
                  }),
            ),
          ),
        ),
      ),
    );

  // Retry every readiness failure that could plausibly clear by waiting on the
  // same instance — a not-yet-listening port, a still-allocating instance, a
  // hung/timed-out probe, even a transient `running === false` read during cold
  // start (which we can't reliably distinguish from a real crash without
  // native's monitor exit code, so we keep polling within the bounded budget
  // and only surface `ContainerCrashedError` if it never recovers). The one
  // failure NOT retried here is a rate limit, which `ensureRunning` already
  // backs off on — spinning the port loop would only make it worse.
  const isTransientReadiness = (e: ReadinessError) =>
    e._tag !== "ContainerRateLimitedError";

  // Phase 2 (native `waitForPort`): poll the port until it accepts connections.
  const waitForPort = (portNumber: number) =>
    readyPorts.has(portNumber)
      ? Effect.void
      : probePort(portNumber).pipe(
          Effect.tapError((err) =>
            Effect.logDebug(`Container not ready (will retry): ${err}`),
          ),
          Effect.retry({
            while: isTransientReadiness,
            schedule: Schedule.spaced(READINESS_POLL_INTERVAL),
            times: PORT_READY_RETRIES,
          }),
          Effect.andThen(() =>
            Effect.sync(() => {
              readyPorts.add(portNumber);
            }),
          ),
        );

  // Phase 1 (native `doStartContainer`) + phase 2: ensure the instance is
  // started (bounded, rate-limit aware), then wait for the port.
  const ensureReady = (portNumber: number) =>
    readyPorts.has(portNumber)
      ? Effect.void
      : ensureRunning.pipe(
          Effect.retry({
            while: (
              e:
                | ContainerError
                | NoContainerInstanceError
                | ContainerRateLimitedError,
            ) => e._tag === "NoContainerInstanceError",
            schedule: Schedule.spaced(READINESS_POLL_INTERVAL),
            times: GET_CONTAINER_RETRIES,
          }),
          Effect.andThen(() => waitForPort(portNumber)),
        );

  const getTcpPort = (portNumber: number) =>
    Effect.succeed({
      fetch: ((
        request:
          | HttpClientRequest.HttpClientRequest
          | HttpServerRequest.HttpServerRequest,
      ) =>
        // Block until the port is ready (bounded), THEN forward the real
        // request exactly once. Readiness is a cheap healthcheck, so the user
        // request is never replayed against a cold container.
        ensureReady(portNumber).pipe(
          Effect.andThen(() => container.getTcpPort(portNumber)),
          Effect.andThen((port: Fetcher) => port.fetch(request as any)),
          Effect.catchDefect((defect: unknown) =>
            Effect.fail(
              new ContainerError({
                message: `Container fetch failed on port ${portNumber}: ${defect}`,
                cause: defect,
              }),
            ),
          ),
          Effect.retry({
            schedule: Schedule.spaced(READINESS_POLL_INTERVAL),
            times: REQUEST_RETRIES,
          }),
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
