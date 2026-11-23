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
      // was not cached. Containers are pinned to linux/amd64 by default.
      yield* docker("pull", "--platform", "linux/amd64", "alpine:3.21");
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
 * Runs DockerLive with `ALCHEMY_LOCAL_CONTAINER_PLATFORM` set (when given) and
 * its docker CLI wrapped in a shim that logs every invocation, then returns
 * the `build` and `pull` commands it ran.
 */
const withLocalPlatform = <A, E>(
  platform: string | undefined,
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
                ...(platform === undefined ? {} : { ALCHEMY_LOCAL_CONTAINER_PLATFORM: platform }),
                DOCKER_BIN: shim,
              }),
            ),
          ),
        ),
      ),
    );
    const commands = (yield* fs.readFileString(log).pipe(Effect.orElseSucceed(() => "")))
      .split("\n")
      .filter((line) => /^(build|pull) /.test(line));
    return { result, commands };
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer));

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
  "builds and pulls linux/amd64 by default",
  () => {
    const built = `alchemy-platform-build-${crypto.randomUUID()}:latest`;
    const pulled = `alchemy-platform-pull-${crypto.randomUUID()}:latest`;
    return Effect.gen(function* () {
      const { commands } = yield* withLocalPlatform(undefined, buildAndPull(built, pulled));
      expect(commands).toHaveLength(2);
      expect(commands[0]).toContain("--platform linux/amd64");
      expect(commands[1]).toBe("pull alpine:3.21 --platform linux/amd64");
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

// `amd64/alpine` has no arm64 variant, so only an arm64 daemon refuses it.
it.live.skipIf(process.arch !== "arm64")(
  "falls back to linux/amd64 with host when the image has no native variant",
  () => {
    const pulled = `alchemy-platform-pull-${crypto.randomUUID()}:latest`;
    return Effect.gen(function* () {
      const { commands } = yield* withLocalPlatform(
        "host",
        Effect.gen(function* () {
          yield* (yield* Docker).pull(pulled, { imageUri: "amd64/alpine:3.21" });
        }),
      );
      expect(commands).toEqual([
        "pull amd64/alpine:3.21",
        "pull amd64/alpine:3.21 --platform linux/amd64",
      ]);
      const arch = yield* docker("image", "inspect", pulled, "--format", "{{.Architecture}}");
      expect(arch.trim()).toBe("amd64");
    }).pipe(Effect.ensuring(removeImages(pulled, "amd64/alpine:3.21")));
  },
  120_000,
);

it.live("rejects an unknown ALCHEMY_LOCAL_CONTAINER_PLATFORM", () =>
  Effect.gen(function* () {
    // A blank value counts as unset and keeps the default.
    for (const value of ["linux/arm64", " host", "HOST"]) {
      const exit = yield* Effect.exit(withLocalPlatform(value, Effect.void));
      expect(exit._tag, `value ${JSON.stringify(value)}`).toBe("Failure");
    }
  }),
);
