import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "alchemy-test";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { Docker, DockerLive } from "@/Docker";

const script = `#!/bin/sh
ref=
for arg in "$@"; do
  ref=$arg
done
case "$ref" in
  known)
    echo 'Error: unable to inspect "localhost:5055/nope:latest": image not known' >&2
    exit 125
    ;;
  missing)
    echo 'Error response from daemon: No such image: missing' >&2
    exit 1
    ;;
  *)
    echo 'Error: boom' >&2
    exit 1
    ;;
esac
`;

it.effect(
  "maps a missing image from podman and docker to NotFound",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "alchemy-podman-" });
      const bin = path.join(dir, "podman");
      yield* fs.writeFileString(bin, script);
      yield* fs.chmod(bin, 0o755);

      const tags = yield* Effect.gen(function* () {
        const docker = yield* Docker;
        const tag = (ref: string) =>
          docker.image.inspect(ref).pipe(
            Effect.flip,
            Effect.map((error) => error.reason._tag),
          );
        return {
          known: yield* tag("known"),
          missing: yield* tag("missing"),
          other: yield* tag("other"),
        };
      }).pipe(
        Effect.provide(DockerLive),
        Effect.provide(ConfigProvider.layer(ConfigProvider.fromUnknown({ DOCKER_BIN: bin }))),
      );

      expect(tags).toEqual({
        known: "NotFound",
        missing: "NotFound",
        other: "Unknown",
      });
    }).pipe(Effect.provide(NodeServices.layer)),
  { tags: ["unit", "local", "provider:docker"] },
);
