/**
 * `@alchemy.run/floci` — Effect-native manager for the
 * [floci](https://floci.io) local cloud emulator.
 *
 * alchemy's AWS local dev points its providers at a floci endpoint. This
 * package owns the emulator lifecycle with a strict resolution order that
 * keeps every local loop registry-free:
 *
 * 1. **Already serving** — if anything answers on the endpoint (e.g.
 *    `bun floci:dev` running `mvn quarkus:dev` from a floci checkout, or a
 *    hand-run container), it wins. Nothing is started, nothing owned.
 * 2. **`ALCHEMY_FLOCI_IMAGE`** — run a specific image (e.g. a locally
 *    built `floci:dev` from a patched fork).
 * 3. **The pinned release** — {@link DEFAULT_FLOCI_IMAGE}, alchemy's
 *    distribution of floci (upstream + alchemy patch set, published from
 *    github.com/alchemy-run/floci).
 *
 * The container is started detached with a stable name — the DOCKER DAEMON
 * is the supervisor, not alchemy: it outlives `alchemy dev` sessions, so
 * queues/tables/functions stay warm between runs and the next session
 * reattaches via the health probe in milliseconds.
 */
import * as Data from "effect/Data";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { execFile } from "node:child_process";
import * as net from "node:net";

/**
 * The pinned floci release alchemy ships: upstream + the alchemy patch
 * set, built and published by the alchemy-run/floci fork's release
 * workflow. Bumping this pin (with a new `x.y.z-alchemy.N` tag) is how an
 * emulator change reaches users.
 */
export const DEFAULT_FLOCI_IMAGE = "ghcr.io/alchemy-run/floci:1.6.0-alchemy.2";

/** Default gateway port (LocalStack-compatible). */
export const DEFAULT_FLOCI_PORT = 4566;

/**
 * ELB listener ports published on the managed container. Floci's ELBv2
 * data plane serves each listener on the listener's OWN port inside the
 * container (see floci's ports doc) — its `*.elb.localhost.floci.io` DNS
 * resolves to 127.0.0.1, so the port must be published for the emulated
 * load balancer to be reachable from the host. Ports already taken on the
 * host are skipped with a warning (the gateway still works without them).
 */
export const DEFAULT_ELB_LISTENER_PORTS = [80, 443];

/** Default name of the managed container. */
export const DEFAULT_CONTAINER_NAME = "alchemy-floci";

export class FlociError extends Data.TaggedError("FlociError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

export interface FlociConfig {
  /**
   * Image to run when the emulator is not already serving.
   * Resolution order: `ALCHEMY_FLOCI_IMAGE` env var, this field,
   * {@link DEFAULT_FLOCI_IMAGE}.
   */
  readonly image?: string | undefined;
  /**
   * Gateway port on the host.
   * @default 4566
   */
  readonly port?: number | undefined;
  /**
   * Name of the managed container (stable so `docker start` can revive a
   * stopped one).
   * @default "alchemy-floci"
   */
  readonly containerName?: string | undefined;
  /**
   * Host directory persisted into the container's data dir. Omit for
   * floci's default in-memory storage (state lives as long as the
   * container).
   */
  readonly storageDir?: string | undefined;
  /**
   * Mount the host Docker socket so floci's container-backed engines
   * (Lambda, ECS, EC2, RDS, ElastiCache) work.
   * @default true
   */
  readonly dockerSocket?: boolean | undefined;
  /**
   * Extra environment variables for the emulator (e.g.
   * `FLOCI_SERVICES_LAMBDA_HOT_RELOAD_ENABLED`).
   */
  readonly env?: Record<string, string> | undefined;
  /**
   * ELB listener ports to publish on the managed container (floci's ALB
   * data plane serves each listener on the listener's own port). Ports
   * already taken on the host are skipped with a warning.
   * @default [80, 443]
   */
  readonly elbListenerPorts?: readonly number[] | undefined;
  /**
   * How long to wait for the emulator to become healthy after starting it
   * (first run includes the image pull).
   * @default 180 seconds
   */
  readonly readinessTimeout?: Duration.Input | undefined;
}

/** A running (or reused) emulator. */
export interface FlociInstance {
  /** Gateway endpoint, e.g. `http://localhost:4566`. */
  readonly endpoint: string;
  /**
   * Whether this manager started the container (`false` when something was
   * already serving on the endpoint — a dev-mode JVM, a hand-run
   * container, or a previous session's container).
   */
  readonly managed: boolean;
  /** Container name when {@link managed} is true. */
  readonly containerName?: string | undefined;
}

const docker = (args: ReadonlyArray<string>) =>
  Effect.callback<{ stdout: string; stderr: string }, FlociError>((resume) => {
    const child = execFile(
      "docker",
      args as Array<string>,
      { maxBuffer: 16 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) {
          resume(
            Effect.fail(
              new FlociError({
                message: `docker ${args[0]} failed: ${stderr.trim() || error.message}`,
                cause: error,
              }),
            ),
          );
        } else {
          resume(Effect.succeed({ stdout, stderr }));
        }
      },
    );
    return Effect.sync(() => child.kill());
  });

/**
 * Whether anything answers HTTP on the endpoint. Any response — even an
 * error status — counts as serving; only a transport failure means down.
 */
export const isServing = (endpoint: string): Effect.Effect<boolean> =>
  Effect.tryPromise({
    try: async (signal) => {
      await fetch(`${endpoint}/_floci/health`, { signal });
      return true;
    },
    catch: () => new FlociError({ message: "unreachable" }),
  }).pipe(Effect.orElseSucceed(() => false));

/** Fail unless `GET /_floci/health` answers 200. */
export const checkHealth = (
  endpoint: string,
): Effect.Effect<void, FlociError> =>
  Effect.tryPromise({
    try: async (signal) => {
      const res = await fetch(`${endpoint}/_floci/health`, { signal });
      if (!res.ok) {
        throw new Error(`health returned ${res.status}`);
      }
    },
    catch: (cause) =>
      new FlociError({
        message: `floci health check failed: ${String(cause)}`,
        cause,
      }),
  });

/** Resolve the image to run: env override, config, pinned default. */
export const resolveImage = (config?: FlociConfig): Effect.Effect<string> =>
  Effect.sync(
    () =>
      process.env.ALCHEMY_FLOCI_IMAGE ?? config?.image ?? DEFAULT_FLOCI_IMAGE,
  );

/** Whether a host TCP port is free (nothing is listening on it). */
const isHostPortFree = (port: number): Effect.Effect<boolean> =>
  Effect.callback<boolean>((resume) => {
    const server = net.createServer();
    server.once("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "EACCES") {
        // Binding low ports (<1024) is privileged for THIS process, but
        // Docker's helper can still publish them — fall back to a
        // connect probe: a refused connection means nothing listens.
        const socket = net.connect({ port, host: "127.0.0.1" });
        socket.once("connect", () => {
          socket.destroy();
          resume(Effect.succeed(false));
        });
        socket.once("error", () => resume(Effect.succeed(true)));
        return;
      }
      resume(Effect.succeed(false));
    });
    server.once("listening", () =>
      server.close(() => resume(Effect.succeed(true))),
    );
    server.listen(port, "127.0.0.1");
    return Effect.sync(() => server.close());
  });

/**
 * The host ports the named container publishes, or `undefined` when the
 * container does not exist.
 */
const publishedPorts = (
  containerName: string,
): Effect.Effect<Set<number> | undefined> =>
  docker([
    "inspect",
    "--format",
    "{{json .HostConfig.PortBindings}}",
    containerName,
  ]).pipe(
    Effect.map(({ stdout }) => {
      let bindings: Record<string, Array<{ HostPort?: string }> | null> | null;
      try {
        bindings = JSON.parse(stdout.trim());
      } catch {
        // Racing a concurrent create/remove of the container can produce
        // partial output — treat it as "unknown", not a crash.
        return undefined;
      }
      const ports = new Set<number>();
      for (const spec of Object.values(bindings ?? {})) {
        for (const bind of spec ?? []) {
          const hostPort = Number(bind.HostPort);
          if (Number.isFinite(hostPort)) ports.add(hostPort);
        }
      }
      return ports;
    }),
    Effect.orElseSucceed(() => undefined),
  );

/**
 * The ELB listener ports the managed container should publish: every
 * configured port that is either already published by the container or
 * still free on the host. Taken ports are skipped (with a warning) so a
 * busy host port never blocks the emulator from starting.
 */
const resolveElbListenerPorts = Effect.fn(function* (
  containerName: string,
  config?: FlociConfig,
) {
  const requested = config?.elbListenerPorts ?? DEFAULT_ELB_LISTENER_PORTS;
  const published = (yield* publishedPorts(containerName)) ?? new Set();
  const desired: number[] = [];
  for (const port of requested) {
    if (published.has(port) || (yield* isHostPortFree(port))) {
      desired.push(port);
    } else {
      yield* Effect.logWarning(
        `floci: host port ${port} is taken — emulated load balancer listeners on ${port} will not be reachable from the host`,
      );
    }
  }
  return desired;
});

/**
 * Ensure a floci emulator is serving and healthy, starting the managed
 * container if needed. Idempotent and cheap when already up (one HTTP
 * probe); see the module doc for the resolution order.
 */
export const ensureFloci = (
  config?: FlociConfig,
): Effect.Effect<FlociInstance, FlociError> =>
  Effect.gen(function* () {
    const port = config?.port ?? DEFAULT_FLOCI_PORT;
    const endpoint = `http://localhost:${port}`;
    const containerName = config?.containerName ?? DEFAULT_CONTAINER_NAME;
    const elbPorts = yield* resolveElbListenerPorts(containerName, config);

    // Converge the managed container's published ports: an older container
    // that predates the ELB listener mappings can't serve emulated load
    // balancers, so it is recreated (emulated state is ephemeral by
    // design — the next apply reconciles it). An UNMANAGED server (a
    // dev-mode JVM, a hand-run container) is never touched.
    const published = yield* publishedPorts(containerName);
    const needsRecreate =
      published !== undefined && elbPorts.some((p) => !published.has(p));
    // Preserve the existing container's image across a recreate (it may be
    // a locally-built dev image rather than the pinned release).
    const existingImage = needsRecreate
      ? yield* docker([
          "inspect",
          "--format",
          "{{.Config.Image}}",
          containerName,
        ]).pipe(
          Effect.map(({ stdout }) => stdout.trim() || undefined),
          Effect.orElseSucceed(() => undefined),
        )
      : undefined;

    if (yield* isServing(endpoint)) {
      if (!needsRecreate) {
        // Something may be serving but still starting — the readiness
        // poll tolerates transient unhealthiness.
        yield* checkHealth(endpoint).pipe(
          Effect.catch(() => waitForHealth(endpoint, config)),
        );
        return { endpoint, managed: false };
      }
      // Only recreate when the server IS our managed container (otherwise
      // removing the container would not free the endpoint anyway).
      yield* Effect.logInfo(
        `floci: recreating ${containerName} to publish ELB listener ports [${elbPorts.join(", ")}]`,
      );
      yield* docker(["rm", "-f", containerName]);
    } else if (needsRecreate) {
      yield* Effect.logInfo(
        `floci: recreating ${containerName} to publish ELB listener ports [${elbPorts.join(", ")}]`,
      );
      yield* docker(["rm", "-f", containerName]);
    } else {
      // Revive a stopped container from a previous session, else run fresh.
      const started = yield* docker(["start", containerName]).pipe(
        Effect.map(() => true),
        Effect.orElseSucceed(() => false),
      );
      if (started) {
        yield* waitForHealth(endpoint, config);
        return { endpoint, managed: true, containerName };
      }
    }

    const image = existingImage ?? (yield* resolveImage(config));
    const args = [
      "run",
      "-d",
      "--name",
      containerName,
      "-p",
      `${port}:4566`,
      ...elbPorts.flatMap((p) => ["-p", `${p}:${p}`]),
      ...(config?.dockerSocket === false
        ? []
        : ["-v", "/var/run/docker.sock:/var/run/docker.sock", "-u", "root"]),
      ...(config?.storageDir !== undefined
        ? [
            "-v",
            `${config.storageDir}:/app/data`,
            "-e",
            "FLOCI_STORAGE_MODE=hybrid",
          ]
        : []),
      ...Object.entries(config?.env ?? {}).flatMap(([key, value]) => [
        "-e",
        `${key}=${value}`,
      ]),
      image,
    ];
    yield* docker(args).pipe(
      // A concurrent ensureFloci (e.g. the dev sidecar racing the CLI)
      // may have created the container between our checks and this run —
      // reuse it instead of failing.
      Effect.catch((error) =>
        error.message.includes("already in use")
          ? Effect.void
          : Effect.fail(error),
      ),
    );

    yield* waitForHealth(endpoint, config);
    return { endpoint, managed: true, containerName };
  });

const waitForHealth = (endpoint: string, config?: FlociConfig) =>
  checkHealth(endpoint).pipe(
    Effect.retry({
      schedule: Schedule.spaced("1 second"),
      times: Math.max(
        1,
        Math.ceil(
          Duration.toSeconds(
            Duration.fromInputUnsafe(config?.readinessTimeout ?? "180 seconds"),
          ),
        ),
      ),
    }),
    Effect.mapError(
      (error) =>
        new FlociError({
          message:
            `floci did not become healthy at ${endpoint}: ${error.message}. ` +
            "Check `docker logs " +
            (config?.containerName ?? DEFAULT_CONTAINER_NAME) +
            "`.",
          cause: error,
        }),
    ),
  );

/** Stop (not remove) the managed container. */
export const stopFloci = (
  containerName: string = DEFAULT_CONTAINER_NAME,
): Effect.Effect<void, FlociError> =>
  Effect.asVoid(docker(["stop", containerName]));

/** Remove the managed container (and its in-memory state). */
export const destroyFloci = (
  containerName: string = DEFAULT_CONTAINER_NAME,
): Effect.Effect<void, FlociError> =>
  Effect.asVoid(docker(["rm", "-f", containerName]));

/** Tail of the managed container's logs. */
export const flociLogs = (
  containerName: string = DEFAULT_CONTAINER_NAME,
  lines = 200,
): Effect.Effect<string, FlociError> =>
  Effect.map(
    docker(["logs", "--tail", String(lines), containerName]),
    ({ stdout, stderr }) => stdout + stderr,
  );
