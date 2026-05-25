import * as Effect from "effect/Effect";
import * as Path from "effect/Path";
import nodePath from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import { importStack } from "../../src/Cli/commands/_shared";
import { evalStack } from "../../src/Stack";
import * as TestCore from "../../src/Test/Core";
import { TestLayers } from "../test.resources";

const fixturePath = fileURLToPath(
  new URL("./fixtures/import-stack-fixture.ts", import.meta.url),
);
const fixtureRelativePath = nodePath.relative(process.cwd(), fixturePath);

const loadFixtureOutput = (path: string) =>
  importStack(path).pipe(
    Effect.provide(Path.layer),
    Effect.flatMap((stackEffect) =>
      evalStack(stackEffect, (stack) => Effect.succeed(stack.output), {
        stage: "test",
      }),
    ),
  );

test("importStack loads a stack entrypoint through a file URL", async () => {
  await expect(
    TestCore.run(loadFixtureOutput(fixtureRelativePath), {
      providers: TestLayers(),
    }),
  ).resolves.toBe("import-stack-fixture");
});

test.runIf(process.platform === "win32")(
  "importStack keeps Windows absolute paths valid by importing through a file URL",
  async () => {
    await expect(
      TestCore.run(loadFixtureOutput(fixturePath), {
        providers: TestLayers(),
      }),
    ).resolves.toBe("import-stack-fixture");
  },
);
