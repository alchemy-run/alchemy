import { describe, expect, it } from "alchemy-test";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import { AlchemyContext } from "@/AlchemyContext";
import { Docker, type CommandOutput } from "@/Docker/Docker";
import { Stack } from "@/Stack";
import { Stage } from "@/Stage";
import {
  makeContainerImageSource,
  type ImageRegistryTarget,
} from "@/Docker/ImageSource";
import type { RegistryCredentials } from "@/Docker/Docker";

describe("Docker image source", {}, () => {
  it.effect(
    "forwards the requested platform when publishing a built image",
    () => {
      const runCalls: ReadonlyArray<string>[] = [];
      const pushCalls: Array<string | undefined> = [];
      const output: CommandOutput = {
        exitCode: ChildProcessSpawner.ExitCode(0),
        stdout: "",
        stderr: "",
      };
      const docker = {
        run: (args: Array<string>) =>
          Effect.sync(() => {
            runCalls.push(args);
            return output;
          }),
        materialize: () => Effect.succeed(undefined),
        image: {
          build: () => Effect.succeed(output),
          push: (
            _ref: string,
            _credentials: RegistryCredentials,
            platform?: string,
          ) =>
            Effect.sync(() => {
              pushCalls.push(platform);
              return output;
            }),
        },
      } as unknown as typeof Docker.Service;
      const credentials: RegistryCredentials = {
        server: "registry.example",
        username: "publisher",
        password: "token",
      };
      const target = (
        credentials: RegistryCredentials | undefined,
      ): ImageRegistryTarget => ({
        repositoryUri: Effect.succeed("registry.example/app"),
        hasTag: () => Effect.succeed(false),
        credentials: Effect.succeed(credentials),
      });

      const resolve = Effect.gen(function* () {
        const images = yield* makeContainerImageSource;
        const source = {
          dockerfile: { content: "FROM scratch\n" },
        };
        const options = {
          id: "image-source-platform",
          source,
          platform: "linux/arm64",
          bootstrap: () => "",
          session: { note: () => Effect.succeed(undefined) },
        };
        yield* images.resolve(options, target(credentials));
        yield* images.resolve(options, target(undefined));
      }).pipe(
        Effect.provideService(Docker, docker),
        Effect.provideService(AlchemyContext, {
          dotAlchemy: ".alchemy",
          dev: false,
          adopt: false,
        }),
        Effect.provideService(Stack, {
          name: "image-source",
          stage: "test",
          resources: {},
          bindings: {},
          actions: {},
        }),
        Effect.provideService(Stage, "test"),
        Effect.provide(NodeServices.layer),
      );

      return resolve.pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            expect(runCalls).toHaveLength(1);
            expect(runCalls[0]).toEqual([
              "image",
              "push",
              "--platform",
              "linux/arm64",
              expect.any(String),
            ]);
            expect(pushCalls).toEqual(["linux/arm64"]);
          }),
        ),
      );
    },
  );
});
