import { AlchemyContext } from "@/AlchemyContext";
import * as Bundle from "@/Bundle/Bundle";
import * as Provider from "@/Provider";
import { ServiceProvider } from "@/Railway/ServiceProvider";
import { FunctionProvider } from "@/Railway/Function";
import * as Layer from "effect/Layer";
import * as Railway from "@/Railway";
import {
  createRailwayFunctionSupport,
  createRailwayHostedSupport,
} from "@/Railway/hosted";
import { Stack } from "@/Stack";
import * as Test from "@/Test/Alchemy";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

const { test } = Test.make({
  providers: Layer.mergeAll(ServiceProvider(), FunctionProvider()),
});

for (const kind of ["Service", "Function"] as const) {
  test.provider(
    `${kind} detects code edits with runtime exports`,
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const stack = yield* Stack;
        const { dotAlchemy } = yield* AlchemyContext;
        yield* fs.makeDirectory(path.resolve(".tmp"), { recursive: true });
        const directory = yield* fs.makeTempDirectoryScoped({
          directory: path.resolve(".tmp"),
          prefix: "railway-code-diff-",
        });
        const main = path.join(directory, "main.ts");
        const source = (value: string) =>
          `export default { fetch: () => new Response(${JSON.stringify(value)}) };`;
        yield* fs.writeFileString(main, source("before"));
        const options = {
          stackName: stack.name,
          stage: stack.stage,
          dotAlchemy,
          virtualEntryPlugin: yield* Bundle.virtualEntryPlugin,
        };
        const hosted =
          kind === "Service"
            ? createRailwayHostedSupport(options)
            : createRailwayFunctionSupport(options);
        const props = {
          project: { projectId: "project" },
          environment: { environmentId: "environment" },
          main,
          isExternal: true,
          port: 3000,
          // Platform supplies runtime exports as Effects during planning.
          exports: { fetch: Effect.succeed("runtime handler") },
        };
        const originalHash = yield* hosted.hash(props);
        const provider = yield* Provider.findProvider(Railway[kind]);
        const diff = (hash: string) =>
          provider.diff!({
            id: "Api",
            fqn: "Api",
            instanceId: "code-diff",
            olds: props,
            news: props,
            oldBindings: [],
            newBindings: [],
            // These are the persisted attributes consulted by both diff methods.
            output: {
              projectId: "project",
              environmentId: "environment",
              code: { hash },
            } as Railway.Service["Attributes"] & Railway.Function["Attributes"],
          });
        expect(yield* diff(originalHash)).toBeUndefined();
        yield* fs.writeFileString(main, source("after"));
        expect(yield* diff(originalHash)).toEqual({ action: "update" });
        const updatedHash = yield* hosted.hash(props);
        expect(updatedHash).not.toBe(originalHash);
        expect(yield* diff(updatedHash)).toBeUndefined();
      }),
    { timeout: 30_000 },
  );
}
