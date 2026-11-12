import { Docker, DockerEnvironment } from "@alchemy.run/docker/Docker";
import { Stage } from "alchemy/Stage";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";

/** Run `effect` with extra environment on every Docker CLI call it makes. */
export const withDockerEnv =
  (env: Record<string, string>) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    Effect.flatMap(DockerEnvironment, (current) =>
      Effect.provideService(effect, DockerEnvironment, { ...current, ...env }),
    );

/**
 * Remove a builder and its BuildKit container, and confirm it is gone. A
 * loaded Docker daemon can time out deleting the container ("context
 * deadline exceeded"), leaving a half-removed node whose build history the
 * next builder of the same name would inherit.
 */
const removeBuilder = Effect.fn(function* (name: string) {
  const docker = yield* Docker;
  const exists = docker.run(["buildx", "inspect", name]).pipe(
    Effect.as(true),
    Effect.orElseSucceed(() => false),
  );
  const retry = Effect.retry({ schedule: Schedule.spaced("3 seconds"), times: 5 });
  if (yield* exists) yield* docker.run(["buildx", "rm", "--force", name]).pipe(retry);
  // `buildx rm` can drop the builder while its container survives, and the
  // container's named state volume holds the build history.
  const node = `buildx_buildkit_${name}0`;
  const container = yield* docker.run(["ps", "-aq", "--filter", `name=^${node}$`]);
  if (container.stdout.trim()) yield* docker.run(["rm", "--force", node]).pipe(retry);
  const state = `${node}_state`;
  const volume = yield* docker.run(["volume", "ls", "-q", "--filter", `name=^${state}$`]);
  if (volume.stdout.trim()) yield* docker.run(["volume", "rm", "--force", state]).pipe(retry);
});

export const withBuilder =
  (prefix: string, options?: { attestations?: boolean }) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    Effect.gen(function* () {
      const name = `${prefix}-${yield* Stage}`;
      const docker = yield* Docker;
      return yield* Effect.acquireUseRelease(
        // A killed run cannot release its builder. Remove any leftover first,
        // so every invocation starts from an empty cache under the same name.
        removeBuilder(name).pipe(
          Effect.andThen(
            docker.run(["buildx", "create", "--name", name, "--driver", "docker-container"]),
          ),
        ),
        () =>
          docker.run(["buildx", "inspect", "--bootstrap"]).pipe(
            Effect.andThen(effect),
            withDockerEnv({
              BUILDX_BUILDER: name,
              BUILDX_NO_DEFAULT_ATTESTATIONS: String(options?.attestations === false),
            }),
          ),
        () => removeBuilder(name).pipe(Effect.orDie),
      );
    });

/**
 * Whether the installed Buildx can export straight to a registry
 * (`buildx build --push` authenticating via DOCKER_AUTH_CONFIG, 0.26+).
 * Older plugins make the provider `--load` the image and `docker push` it.
 */
export const supportsRegistryExport = Effect.gen(function* () {
  const docker = yield* Docker;
  const version = yield* docker.run(["buildx", "version"]);
  const match = /buildx v?(\d+)\.(\d+)\./.exec(version.stdout);
  if (!match) return false;
  return Number(match[1]) >= 1 || Number(match[2]) >= 26;
});

const decodeBuild = Schema.Struct({ ref: Schema.String, status: Schema.String }).pipe(
  Schema.fromJsonString,
  Schema.decodeEffect,
);

export const buildHistory = Effect.gen(function* () {
  const docker = yield* Docker;
  const history = yield* docker.run(["buildx", "history", "ls", "--format", "json"]);
  return yield* Effect.forEach(history.stdout.split("\n").filter(Boolean), (line) =>
    decodeBuild(line),
  );
});
