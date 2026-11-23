import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import { Docker, DockerLive } from "../Docker.ts";
import { DOCKER_BIN, docker } from "./helpers/docker.ts";

it.live(
  "pulls an unprepared image again after a failed container create",
  () => {
    // Unresolvable registry: the first on-demand pull must fail.
    const image = "alchemy-test.invalid/missing:retry";
    const name = `alchemy-pull-retry-${crypto.randomUUID()}`;
    return Effect.gen(function* () {
      const config = yield* (yield* Docker).getWorkerdDockerConfiguration;
      const create = Effect.promise(() =>
        fetch(`http://${config.localDocker!.socketPath}/containers/create?name=${name}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ Image: image, Env: [] }),
        }).then(async (response) => ({ status: response.status, body: await response.text() })),
      );

      const failed = yield* create;
      expect(failed.status).toBe(500);

      // Once the image exists, the same create must succeed: the failed pull
      // was not cached.
      yield* docker("pull", "alpine:3.21");
      yield* docker("tag", "alpine:3.21", image);
      const created = yield* create;
      expect(created.status).toBe(201);
    }).pipe(
      Effect.ensuring(
        Effect.ignore(docker("rm", "--force", name)).pipe(
          Effect.andThen(Effect.ignore(docker("rmi", image))),
        ),
      ),
      Effect.provide(
        Layer.provide(DockerLive, Layer.mergeAll(NodeServices.layer, SecureRandom.layerWebCrypto)),
      ),
    );
  },
  60_000,
);

it.live(
  "uses a user image that exists only in the local Docker without pulling it",
  () => {
    // A tag no registry holds, as with an image built or `docker load`ed locally.
    const image = "alchemy-test.invalid/local-only:dev";
    const tag = `alchemy-local-only-${crypto.randomUUID()}:latest`;
    return Effect.gen(function* () {
      yield* docker("pull", "--platform", "linux/amd64", "alpine:3.21");
      yield* docker("tag", "alpine:3.21", image);
      yield* (yield* Docker).pull(tag, { imageUri: image });
      const id = yield* docker("image", "inspect", tag, "--format", "{{.Id}}");
      expect(id.trim()).not.toBe("");
    }).pipe(
      Effect.ensuring(
        Effect.ignore(docker("rmi", tag)).pipe(Effect.andThen(Effect.ignore(docker("rmi", image)))),
      ),
      Effect.provide(
        Layer.provide(DockerLive, Layer.merge(NodeServices.layer, SecureRandom.layerWebCrypto)),
      ),
    );
  },
  60_000,
);

/**
 * Runs DockerLive with `ALCHEMY_LOCAL_CONTAINER_PLATFORM` set and its docker
 * CLI wrapped in a shim that logs every invocation, then returns the `build`
 * and `pull` commands it ran.
 */
const withLocalPlatform = <A, E>(
  platform: string,
  body: Effect.Effect<A, E, Docker | FileSystem.FileSystem>,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const dir = yield* fs.makeTempDirectoryScoped({ prefix: "alchemy-platform-" });
    const log = `${dir}/docker.log`;
    const shim = `${dir}/docker`;
    yield* fs.writeFileString(
      shim,
      `#!/bin/sh\necho "$*" >> ${JSON.stringify(log)}\nexec ${JSON.stringify(DOCKER_BIN)} "$@"\n`,
    );
    yield* fs.chmod(shim, 0o755);
    const result = yield* body.pipe(
      Effect.provide(
        Layer.provideMerge(
          DockerLive,
          Layer.mergeAll(
            NodeServices.layer,
            SecureRandom.layerWebCrypto,
            ConfigProvider.layer(
              ConfigProvider.fromUnknown({
                ALCHEMY_LOCAL_CONTAINER_PLATFORM: platform,
                DOCKER_BIN: shim,
              }),
            ),
          ),
        ),
      ),
    );
    const commands = (yield* fs.readFileString(log))
      .split("\n")
      .filter((line) => /^(build|pull) /.test(line));
    return { result, commands };
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer));

// A FROM-only Dockerfile has no RUN step, so a foreign platform builds
// without emulation on any host.
const buildAndPull = (built: string, pulled: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const docker = yield* Docker;
    const dir = yield* fs.makeTempDirectoryScoped({ prefix: "alchemy-platform-ctx-" });
    const dockerfile = `${dir}/Dockerfile`;
    yield* fs.writeFileString(dockerfile, "FROM alpine:3.21\n");
    yield* docker.build(built, { dockerfile, context: dir });
    yield* docker.pull(pulled, { imageUri: "alpine:3.21" });
  }).pipe(Effect.scoped);

const removeImages = (...tags: Array<string>) =>
  Effect.forEach(tags, (tag) => Effect.ignore(docker("rmi", tag)), { discard: true });

it.live(
  "builds and pulls the platform set in ALCHEMY_LOCAL_CONTAINER_PLATFORM",
  () => {
    const built = `alchemy-platform-build-${crypto.randomUUID()}:latest`;
    const pulled = `alchemy-platform-pull-${crypto.randomUUID()}:latest`;
    return Effect.gen(function* () {
      const { commands } = yield* withLocalPlatform("linux/arm64", buildAndPull(built, pulled));
      expect(commands).toHaveLength(2);
      expect(commands[0]).toContain("--platform linux/arm64");
      expect(commands[1]).toBe("pull alpine:3.21 --platform linux/arm64");
      const arch = yield* docker("image", "inspect", built, "--format", "{{.Architecture}}");
      expect(arch.trim()).toBe("arm64");
    }).pipe(Effect.ensuring(removeImages(built, pulled)));
  },
  120_000,
);

it.live(
  "leaves the platform to Docker with ALCHEMY_LOCAL_CONTAINER_PLATFORM=host",
  () => {
    const built = `alchemy-platform-build-${crypto.randomUUID()}:latest`;
    const pulled = `alchemy-platform-pull-${crypto.randomUUID()}:latest`;
    return Effect.gen(function* () {
      const { commands } = yield* withLocalPlatform("host", buildAndPull(built, pulled));
      expect(commands).toHaveLength(2);
      expect(commands[0]).not.toContain("--platform");
      expect(commands[1]).toBe("pull alpine:3.21");
    }).pipe(Effect.ensuring(removeImages(built, pulled)));
  },
  120_000,
);
