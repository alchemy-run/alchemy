import { ContainerRuntime, makeContainerBootstrap } from "@alchemy.run/docker/ContainerRuntime";
import { DockerLive } from "@alchemy.run/docker/Docker";
import {
  bundleMainProgram,
  containerBundleLayout,
  makeContainerImageSource,
} from "@alchemy.run/docker/ImageSource";
import { makeServiceImage } from "@alchemy.run/docker/ServiceImage";
import { expect, layer } from "@alchemy.run/test";
import { BunServices } from "@effect/platform-bun";
import { AlchemyContext } from "alchemy/AlchemyContext";
import { Stack } from "alchemy/Stack";
import { Stage } from "alchemy/Stage";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { ChildProcess } from "effect/process";
import { ChildProcessSpawner } from "effect/process/ChildProcessSpawner";

const tags = ["unit", "provider:docker", "local"];
const source = { main: new URL("./fixtures/container-runtime-job.ts", import.meta.url).href };

layer(BunServices.layer)("container runtime", (test) => {
  test.effect(
    "explicit Bun keeps the default service image hash",
    () =>
      Effect.gen(function* () {
        const runtime = yield* ContainerRuntime.pipe(Effect.provide(ContainerRuntime.bun));
        expect(containerBundleLayout(runtime).entrypoint).toBe(
          'ENTRYPOINT ["bun", "/app/index.mjs"]',
        );
        const fs = yield* FileSystem.FileSystem;
        const dotAlchemy = yield* fs.makeTempDirectoryScoped();
        const hash = makeServiceImage.pipe(
          Effect.flatMap((images) => images.hash({ source })),
          Effect.provideService(AlchemyContext, { dotAlchemy, dev: false, adopt: false }),
          Effect.provide(DockerLive),
        );
        const defaultHash = yield* hash;
        expect(yield* hash.pipe(Effect.provide(ContainerRuntime.bun))).toBe(defaultHash);
        expect(yield* hash.pipe(Effect.provide(ContainerRuntime.node))).not.toBe(defaultHash);
      }),
    { tags },
  );

  test.effect(
    "agent image identity and the mounted executable follow the selected runtime",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const dotAlchemy = yield* fs.makeTempDirectoryScoped();
        const options = {
          id: "Agent",
          source: { image: "alpine:3" },
          bootstrap: () => "",
          agent: {
            main: import.meta.resolve("@alchemy.run/aws/Bootstrap/EcsSandbox"),
            platformBootstrap: "@alchemy.run/aws/Bootstrap/EcsSandboxProcess",
          },
          session: { note: () => Effect.void },
        };
        const resolve = Effect.gen(function* () {
          const images = yield* makeContainerImageSource;
          const resolved = yield* images.resolve(options, {
            repositoryUri: Effect.succeed("example/agent"),
            hasTag: () => Effect.succeed(true),
            credentials: Effect.succeed(undefined),
          });
          expect(resolved.codeHash).toBe(yield* images.hash(options));
          return resolved;
        }).pipe(
          Effect.provideService(Stack, {
            name: "container-runtime-test",
            stage: "test",
            bindings: {},
            resources: {},
            actions: {},
          }),
          Effect.provideService(Stage, "test"),
          Effect.provideService(AlchemyContext, { dotAlchemy, dev: false, adopt: false }),
          Effect.provide(DockerLive),
        );
        const bun = yield* resolve.pipe(Effect.provide(ContainerRuntime.bun));
        const node = yield* resolve.pipe(Effect.provide(ContainerRuntime.node));
        const nodeRuntime = yield* ContainerRuntime.pipe(Effect.provide(ContainerRuntime.node));
        const custom = yield* resolve.pipe(
          Effect.provide(
            ContainerRuntime.custom({
              ...nodeRuntime,
              command: ["node", "--enable-source-maps"],
            }),
          ),
        );
        expect(bun.agent?.entryPoint).toContain("/opt/alchemy/sandbox/bun");
        expect(node.agent?.entryPoint).toContain("/opt/alchemy/sandbox/node");
        expect(custom.agent?.entryPoint).toContain("--enable-source-maps");
        expect(bun.agent?.pty).toBe("bun");
        expect(node.agent?.pty).toBeUndefined();
        expect(node.imageUri).toBe(bun.imageUri);
        expect(node.codeHash).not.toBe(bun.codeHash);
      }),
    { tags },
  );

  test.effect(
    "the Node bundle runs a job with the platform services and exits",
    () =>
      Effect.gen(function* () {
        const runtime = yield* ContainerRuntime.pipe(Effect.provide(ContainerRuntime.node));
        const bundled = yield* bundleMainProgram({
          source,
          runtime,
          bootstrap: makeContainerBootstrap(
            runtime.platformModule,
            "alchemy/Runtime/ContainerProcess",
            "default",
            "job",
          ),
        });
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const context = yield* fs.makeTempDirectoryScoped();
        expect(bundled.files.filter((file) => file.path.endsWith(".js"))).toEqual([]);
        for (const file of bundled.files) {
          yield* fs.writeFile(path.join(context, file.path), file.content);
        }
        const spawner = yield* ChildProcessSpawner;
        const lines = yield* spawner.lines(
          ChildProcess.make("node", ["index.mjs"], {
            cwd: context,
            env: { ALCHEMY_STACK_NAME: "container-runtime-test", ALCHEMY_STAGE: "test" },
            extendEnv: true,
          }),
        );
        expect(lines).toContain("job ran under Node");
        expect(lines).toContain("Container job completed.");
      }),
    { tags },
  );
});
