/**
 * Lifecycle helpers for a local AWS emulator (floci — a LocalStack-compatible
 * emulator on port 4566, https://floci.io).
 *
 * The `local` AWS auth method points `AWSEnvironment.endpoint` at the
 * emulator; this module makes sure something is actually listening there,
 * auto-starting the floci container for the default endpoint.
 */
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as ChildProcess from "effect/unstable/process/ChildProcess";

export const DEFAULT_LOCAL_ENDPOINT = "http://localhost:4566";

const FLOCI_CONTAINER_NAME = "floci";
const FLOCI_IMAGE = "floci/floci:latest";

export class LocalEmulatorError extends Error {
  readonly _tag = "LocalEmulatorError";
}

/**
 * Any HTTP response (even an error status) proves a listener; only transport
 * failures mean the emulator is down.
 */
const isReachable = (endpoint: string) =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    return yield* client.get(endpoint).pipe(
      Effect.as(true),
      Effect.catch((error) =>
        Effect.succeed(error.reason._tag !== "TransportError"),
      ),
    );
  });

const docker = (args: string[]) =>
  Effect.gen(function* () {
    const handle = yield* ChildProcess.make("docker", args, {
      shell: false,
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
    });
    return yield* handle.exitCode;
  }).pipe(
    Effect.scoped,
    Effect.catch(() => Effect.succeed(-1)),
  );

/**
 * Ensure an emulator is listening at `endpoint`. For the default endpoint
 * (with `autoStart`), starts — or creates — the `floci` Docker container and
 * waits for it to come up (first run pulls the image, so the wait is
 * generous). Fails with {@link LocalEmulatorError} when the endpoint stays
 * unreachable.
 */
export const ensureLocalEmulator = Effect.fn(function* (options: {
  endpoint: string;
  autoStart: boolean;
}) {
  if (yield* isReachable(options.endpoint)) {
    return;
  }
  if (!options.autoStart) {
    return yield* Effect.fail(
      new LocalEmulatorError(
        `no local AWS emulator is listening at ${options.endpoint} — start floci with:\n` +
          `  docker run -d --name ${FLOCI_CONTAINER_NAME} -p 4566:4566 -v /var/run/docker.sock:/var/run/docker.sock -u root ${FLOCI_IMAGE}`,
      ),
    );
  }

  yield* Effect.logInfo(
    `starting local AWS emulator (${FLOCI_IMAGE}) at ${options.endpoint}`,
  );
  // A previously-created container restarts fast; otherwise create one. The
  // Docker socket mount is required for floci's Docker-backed services
  // (Lambda, RDS, ...).
  const started = yield* docker(["start", FLOCI_CONTAINER_NAME]);
  if (started !== 0) {
    const ran = yield* docker([
      "run",
      "-d",
      "--name",
      FLOCI_CONTAINER_NAME,
      "-p",
      "4566:4566",
      "-v",
      "/var/run/docker.sock:/var/run/docker.sock",
      "-u",
      "root",
      FLOCI_IMAGE,
    ]);
    if (ran !== 0) {
      return yield* Effect.fail(
        new LocalEmulatorError(
          `failed to start the ${FLOCI_CONTAINER_NAME} Docker container — is Docker running?`,
        ),
      );
    }
  }

  yield* isReachable(options.endpoint).pipe(
    Effect.flatMap((up) =>
      up
        ? Effect.void
        : Effect.fail(
            new LocalEmulatorError(
              `local AWS emulator did not become reachable at ${options.endpoint}`,
            ),
          ),
    ),
    Effect.retry({
      while: (e) => e._tag === "LocalEmulatorError",
      // First run pulls the image; allow up to two minutes.
      schedule: Schedule.spaced("1 second"),
      times: 120,
    }),
  );
});
