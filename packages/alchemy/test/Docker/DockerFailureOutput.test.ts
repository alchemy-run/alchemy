import { Docker, DockerLive } from "@/Docker";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, layer } from "alchemy-test";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

/**
 * A failing build must report why it failed, not just its exit code. The
 * builder splits its diagnosis over both streams, so `Docker.run` keeps
 * `stdout` as well as `stderr` in the error it raises.
 *
 * `DOCKER_BIN` is the seam: a script standing in for `docker` writes to the
 * stream under test and exits non-zero. No daemon is involved.
 */
const describe = layer(NodeServices.layer);

/** Writes an executable stand-in for `docker` and returns its path. */
const fakeDocker = (script: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const dir = yield* fs.makeTempDirectoryScoped({
      prefix: "alchemy-docker-bin-",
    });
    const bin = path.join(dir, "docker");
    yield* fs.writeFileString(bin, `#!/bin/sh\n${script}\n`);
    yield* fs.chmod(bin, 0o755);
    return bin;
  });

/** Runs a failing `docker image build` against the stand-in and returns its error. */
const buildFailure = (script: string) =>
  Effect.gen(function* () {
    const bin = yield* fakeDocker(script);
    return yield* Effect.gen(function* () {
      const docker = yield* Docker;
      return yield* Effect.flip(docker.run(["image", "build", "."]));
    }).pipe(
      Effect.provide(
        // `DOCKER_BIN` is read once, when the layer is built.
        Layer.provide(
          DockerLive,
          ConfigProvider.layer(ConfigProvider.fromUnknown({ DOCKER_BIN: bin })),
        ),
      ),
    );
  });

describe("Docker.run failure output", (it) => {
  it.effect("keeps a failing build's stdout in the error", () =>
    Effect.gen(function* () {
      const error = yield* buildFailure(
        'echo "npm ERR! missing script: build"\nexit 1',
      );
      expect(error.reason._tag).toBe("Unknown");
      expect(error.reason.description).toContain(
        "npm ERR! missing script: build",
      );
      expect(error.reason.description).toContain("exited with code 1");
    }),
  );

  it.effect("keeps both streams when the build writes to each", () =>
    Effect.gen(function* () {
      const error = yield* buildFailure(
        [
          'echo "#7 [3/3] RUN bun run build"',
          'echo "ERROR: failed to solve: exit code: 1" >&2',
          "exit 1",
        ].join("\n"),
      );
      expect(error.reason.description).toContain("ERROR: failed to solve");
      expect(error.reason.description).toContain("#7 [3/3] RUN bun run build");
    }),
  );

  it.effect("says so when a failing command wrote nothing", () =>
    Effect.gen(function* () {
      const error = yield* buildFailure("exit 2");
      expect(error.reason.description).toContain("exited with code 2");
      expect(error.reason.description).toContain("wrote no output");
    }),
  );

  it.effect("still classifies a daemon NotFound from stderr", () =>
    Effect.gen(function* () {
      const error = yield* buildFailure(
        'echo "Error response from daemon: No such image: nope:latest" >&2\nexit 1',
      );
      expect(error.reason._tag).toBe("NotFound");
      expect(error.reason.description).toContain("No such image");
    }),
  );
});
