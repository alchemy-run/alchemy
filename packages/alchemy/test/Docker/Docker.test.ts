import { Docker, DockerLive } from "@/Docker";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, layer } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Redacted from "effect/Redacted";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

const describe = layer(Layer.provideMerge(DockerLive, NodeServices.layer));

describe("Docker.materialize", (it) => {
  it.effect("materializes a Dockerfile in the target directory", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const docker = yield* Docker;
      const root = yield* fs.makeTempDirectoryScoped({
        prefix: "alchemy-docker-ctx-",
      });
      const ctx = path.join(root, "ctx");
      yield* docker.materialize({
        context: ctx,
        dockerfile: "FROM scratch\n",
        files: [],
      });
      const dockerfile = path.join(ctx, "Dockerfile");
      expect(yield* fs.exists(dockerfile)).toBe(true);
      expect(yield* fs.readFileString(dockerfile)).toBe("FROM scratch\n");
    }),
  );

  it.effect("writes nested context files", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const docker = yield* Docker;
      const root = yield* fs.makeTempDirectoryScoped({
        prefix: "alchemy-docker-path-",
      });
      const ctx = path.join(root, "ctx");
      yield* docker.materialize({
        context: ctx,
        dockerfile: "FROM scratch\n",
        files: [{ path: "nested/hello.txt", content: "hi" }],
      });
      expect(
        yield* fs.readFileString(path.join(ctx, "nested", "hello.txt")),
      ).toBe("hi");
    }),
  );
});

describe("Docker.image", (it) => {
  for (const [name, auth] of [
    [
      "invalid JSON",
      '{"auths":{"source.invalid":{"auth":"AUTH_SECRET_SENTINEL"}},',
    ],
    [
      "invalid base64",
      '{"auths":{"source.invalid":{"auth":"AUTH_SECRET_SENTINEL!"}}}',
    ],
    [
      "missing credential separator",
      '{"auths":{"source.invalid":{"auth":"QVVUSF9TRUNSRVRfU0VOVElORUw="}}}',
    ],
  ]) {
    it.effect(`rejects ${name} without exposing registry credentials`, () =>
      Effect.gen(function* () {
        const docker = yield* Docker;
        const fs = yield* FileSystem.FileSystem;
        const context = yield* fs.makeTempDirectoryScoped({
          prefix: "alchemy-invalid-auth-",
        });
        yield* docker.materialize({
          context,
          dockerfile: "FROM scratch\n",
          files: [],
        });
        const result = yield* docker.image
          .build(
            { context, tag: "registry.invalid/invalid-auth:latest" },
            undefined,
            {
              server: "registry.invalid",
              username: "publisher",
              password: Redacted.make("DESTINATION_SECRET_SENTINEL"),
            },
          )
          .pipe(Effect.flip);
        expect(result.reason._tag).toBe("InvalidData");
        expect(result.reason.description).toContain("DOCKER_AUTH_CONFIG");
        const serialized = yield* Effect.sync(() => JSON.stringify(result));
        expect(serialized).not.toContain("AUTH_SECRET_SENTINEL");
        expect(serialized).not.toContain("QVVUSF9TRUNSRVRfU0VOVElORUw=");
        expect(serialized).not.toContain("DESTINATION_SECRET_SENTINEL");
      }).pipe(
        Effect.provide(
          ConfigProvider.layer(
            ConfigProvider.fromUnknown({ DOCKER_AUTH_CONFIG: auth }),
          ),
        ),
      ),
    );
  }

  it.effect("builds a minimal image with content Dockerfile", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const docker = yield* Docker;
      const tag = "alchemy-docker-test:minimal";
      yield* Effect.addFinalizer(() =>
        docker.image.remove(tag, true).pipe(
          Effect.catchReason("PlatformError", "NotFound", () => Effect.void),
          Effect.ignore,
        ),
      );
      const root = yield* fs.makeTempDirectoryScoped({
        prefix: "alchemy-docker-build-",
      });
      const ctx = path.join(root, "ctx");
      yield* docker.materialize({
        context: ctx,
        dockerfile: [
          "FROM alpine:3.19",
          "RUN echo ok > /tmp/ok.txt",
          'CMD ["cat", "/tmp/ok.txt"]',
          "",
        ].join("\n"),
        files: [],
      });
      yield* docker.image.build({ tag, context: ctx });
      const inspect = yield* docker.image.inspect(tag);
      expect(inspect.Id.length).toBeGreaterThan(0);
    }),
  );

  it.effect("passes --platform and --build-arg", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const docker = yield* Docker;
      const tag = "alchemy-docker-test:args";
      yield* Effect.addFinalizer(() =>
        docker.image.remove(tag, true).pipe(
          Effect.catchReason("PlatformError", "NotFound", () => Effect.void),
          Effect.ignore,
        ),
      );
      const root = yield* fs.makeTempDirectoryScoped({
        prefix: "alchemy-docker-build-",
      });
      const ctx = path.join(root, "ctx");
      yield* docker.materialize({
        context: ctx,
        dockerfile: [
          "FROM alpine:3.19",
          "ARG FOO=default",
          'RUN echo "$FOO" > /out.txt',
          "",
        ].join("\n"),
        files: [],
      });
      yield* docker.image.build({
        tag,
        context: ctx,
        platform: "linux/amd64",
        "build-arg": { FOO: "from-arg" },
      });
      const out = yield* docker.run(["run", "--rm", tag, "cat", "/out.txt"]);
      expect(out.stdout.trim()).toBe("from-arg");
    }),
  );

  it.effect("respects multi-stage --target", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const docker = yield* Docker;
      const tag = "alchemy-docker-test:target";
      yield* Effect.addFinalizer(() =>
        docker.image.remove(tag, true).pipe(
          Effect.catchReason("PlatformError", "NotFound", () => Effect.void),
          Effect.ignore,
        ),
      );
      const root = yield* fs.makeTempDirectoryScoped({
        prefix: "alchemy-docker-build-",
      });
      const ctx = path.join(root, "ctx");
      yield* docker.materialize({
        context: ctx,
        dockerfile: [
          "FROM alpine:3.19 AS base",
          "RUN echo base > /stage.txt",
          "",
          "FROM alpine:3.19 AS secondary",
          "RUN echo secondary > /stage.txt",
          "",
        ].join("\n"),
        files: [],
      });
      yield* docker.image.build({ tag, context: ctx, target: "secondary" });
      const out = yield* docker.run(["run", "--rm", tag, "cat", "/stage.txt"]);
      expect(out.stdout.trim()).toBe("secondary");
    }),
  );
});
