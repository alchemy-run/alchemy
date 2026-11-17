import { describe, expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as Effect from "effect/Effect";
import { AlchemyContext } from "@/AlchemyContext";
import { ALCHEMY_DEV } from "@/Phase";
import { TestLayers } from "./test.resources.ts";

// A stack must read the same dev flag the providers run on (#3322).
describe("ALCHEMY_DEV in Test.make", { tags: ["unit", "local"] }, () => {
  for (const dev of [true, false]) {
    const { test } = Test.make({ providers: TestLayers(), dev, sidecar: false });
    test.provider(`matches AlchemyContext.dev with dev: ${dev}`, (stack) =>
      Effect.gen(function* () {
        const { contextDev, alchemyDev } = yield* Effect.gen(function* () {
          const context = yield* AlchemyContext;
          return { contextDev: context.dev, alchemyDev: yield* ALCHEMY_DEV };
        }).pipe(stack.deploy);
        expect(alchemyDev).toBe(contextDev);
      }),
    );
  }
});
