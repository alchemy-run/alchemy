import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
import * as Docker from "@/Docker";
import { Stage } from "@/Stage.ts";
import { inMemoryState } from "@/State";
import * as Test from "@/Test/Alchemy.ts";

const { test } = Test.make({ providers: Docker.providers(), state: inMemoryState() });

test.provider(
  "publishes through a non-loading builder to a disposable local registry",
  (stack) =>
    Effect.gen(function* () {
      const docker = yield* Docker.Docker;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const name = `alchemy-registry-image-${yield* Stage}`;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "alchemy-registry-live-" });
      yield* fs.writeFileString(
        path.join(root, "Dockerfile"),
        "FROM scratch\nLABEL alchemy.registry=true\n",
      );
      yield* Effect.acquireUseRelease(
        docker.run(["run", "-d", "--rm", "--name", name, "-p", "127.0.0.1::5000", "registry:2"]),
        () =>
          Effect.gen(function* () {
            const binding = yield* docker.run(["port", name, "5000/tcp"]);
            const port = binding.stdout.trim().split(":").at(-1)!;
            const server = `localhost:${port}`;
            const config = path.join(root, "buildkitd.toml");
            yield* fs.writeFileString(config, `[registry."${server}"]\n  http = true\n`);
            yield* docker
              .run(["exec", name, "wget", "-q", "-O", "-", "http://127.0.0.1:5000/v2/"])
              .pipe(Effect.retry({ times: 10, schedule: Schedule.spaced("200 millis") }));
            yield* Effect.acquireUseRelease(
              docker.run([
                "buildx",
                "create",
                "--name",
                name,
                "--driver",
                "docker-container",
                "--driver-opt",
                "network=host",
                "--buildkitd-config",
                config,
              ]),
              () =>
                Effect.acquireUseRelease(
                  Effect.sync(() => {
                    const previous = process.env.BUILDX_BUILDER;
                    process.env.BUILDX_BUILDER = name;
                    return previous;
                  }),
                  () =>
                    Effect.gen(function* () {
                      const program = Docker.Image("registry-image", {
                        name: `${server}/app`,
                        registry: { server, username: "local", password: Redacted.make("local") },
                        build: {
                          context: root,
                          platform: "linux/amd64",
                          options: ["--provenance=false"],
                        },
                      });
                      yield* stack.destroy();
                      const first = yield* stack.deploy(program);
                      expect(first.imageRef).toMatch(/@sha256:[a-f0-9]{64}$/);
                      expect(first.imageId).toBeUndefined();
                      const local = yield* docker.image
                        .inspect(`${server}/app:${first.tag}`)
                        .pipe(
                          Effect.catchReason("PlatformError", "NotFound", () => Effect.undefined),
                        );
                      expect(local).toBeUndefined();
                      const plan = yield* stack.plan(program);
                      expect(plan.resources["registry-image"]).toMatchObject({ action: "noop" });
                      yield* stack.destroy();
                      const reused = yield* stack.deploy(program);
                      expect(reused.imageRef).toBe(first.imageRef);
                      yield* stack.destroy();
                    }),
                  (previous) =>
                    Effect.sync(() => {
                      if (previous === undefined) delete process.env.BUILDX_BUILDER;
                      else process.env.BUILDX_BUILDER = previous;
                    }),
                ),
              () => docker.run(["buildx", "rm", "--force", name]),
            );
          }),
        () => docker.run(["rm", "-f", name]),
      );
    }),
  { tags: ["provider:docker", "local"], exclusive: true, timeout: 120_000 },
);
