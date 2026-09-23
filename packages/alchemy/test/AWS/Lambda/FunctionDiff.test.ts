import * as AWS from "@/AWS";
import { makeFunctionBundler } from "@/AWS/Lambda/FunctionBundle";
import * as Output from "@/Output";
import * as Provider from "@/Provider";
import * as Test from "@/Test/Alchemy";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

const { test } = Test.make({ providers: AWS.providers() });

test.provider(
  "Effect-native function detects source edits during planning",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fs.makeTempDirectoryScoped({
        prefix: "alchemy-lambda-function-diff-",
      });
      const main = path.join(directory, "handler.ts");
      const source = (value: string) =>
        `export const handler = () => ${JSON.stringify(value)};\n`;
      yield* fs.writeFileString(main, source("before"));

      const persisted = {
        main,
        handler: "handler",
        isExternal: true,
        functionUrl: false,
        exports: {},
      } as unknown as AWS.Lambda.FunctionProps;
      const desired = {
        ...persisted,
        // Platform injects runtime handlers as Effects for Effect-native
        // functions. They are runtime wiring, not unresolved IaC inputs.
        exports: { handler: Effect.void },
      } as unknown as AWS.Lambda.FunctionProps;
      const originalHash = (yield* (yield* makeFunctionBundler).bundleCode(
        "EffectFunction",
        {
          main,
          handler: "handler",
          isExternal: true,
          functionUrl: false,
        },
      )).identityHash;
      const provider = yield* Provider.findProvider(AWS.Lambda.Function);
      const diff = (news: AWS.Lambda.FunctionProps) =>
        provider.diff!({
          id: "EffectFunction",
          fqn: "EffectFunction",
          instanceId: "effect-function-diff",
          olds: persisted,
          news,
          oldBindings: [],
          newBindings: [],
          output: {
            functionName: "effect-function",
            code: { hash: originalHash },
          } as AWS.Lambda.Function["Attributes"],
        });

      expect(yield* diff(desired)).toEqual({ action: "noop" });

      yield* fs.writeFileString(main, source("after"));
      expect(yield* diff(desired)).toEqual({ action: "update" });

      // Runtime Effects must be ignored without erasing genuine unresolved
      // Outputs: provider-specific diffing still defers until they resolve.
      expect(
        yield* diff({
          ...desired,
          main: Output.literal(main),
        } as unknown as AWS.Lambda.FunctionProps),
      ).toBeUndefined();
    }),
  {
    tags: ["unit", "provider:aws", "provider:aws:lambda", "local"],
    timeout: 30_000,
  },
);
