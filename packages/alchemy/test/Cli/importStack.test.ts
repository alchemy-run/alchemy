import * as Effect from "effect/Effect";
import * as Config from "effect/Config";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import { fileURLToPath } from "node:url";
import path from "pathe";
import { describe, expect, test } from "alchemy-test";
import {
  collectAuthProviders,
  buildStackProviders,
  DEFAULT_ENTRYPOINT,
  importStack,
  open,
  routeCacheLayer,
  StackModuleLoader,
} from "@/Alchemist/Session.ts";
import { Secrets, Stack, Stage, inMemoryState } from "@/index.ts";
import * as CliKit from "@/Cli/CliKit/index.ts";
import { evalStack } from "../../src/Stack";
import * as TestCore from "../../src/Test/Core";
import { TestLayers } from "../test.resources";

const fixtureAbsolutePath = fileURLToPath(
  import.meta.resolve("./fixtures/import-stack-fixture.ts"),
);
const fixtureRelativePath = path.relative(process.cwd(), fixtureAbsolutePath);

const runFixture = (path: string) =>
  TestCore.run(
    importStack(path).pipe(
      Effect.flatMap((stackEffect) =>
        evalStack(stackEffect, (stack) => Effect.succeed(stack.output), {
          stage: "test",
        }),
      ),
    ),
    {
      providers: TestLayers(),
    },
  );

describe("importStack", () => {
  test("loads stack secrets for sessions and provider-only builds with CLI overrides", () =>
    TestCore.run(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const dir = yield* fs.makeTempDirectoryScoped();
        const envFile = path.join(dir, "cli.env");
        yield* fs.writeFileString(envFile, "ALCHEMY_DOTENV_SESSION_VALUE=cli");
        for (const stage of ["prod", "placeholder"]) {
          yield* fs.writeFileString(
            path.join(dir, `${stage}.env`),
            `ALCHEMY_DOTENV_SESSION_VALUE=file\nALCHEMY_DOTENV_SESSION_STAGE=${stage}\nALCHEMY_PROFILE=file-profile`,
          );
        }
        const observations: string[][] = [];
        const stack = Stack(
          "session-secrets",
          {
            state: inMemoryState(),
            providers: Layer.effectDiscard(
              Effect.gen(function* () {
                observations.push([
                  yield* Config.String("ALCHEMY_DOTENV_SESSION_VALUE"),
                  yield* Config.String("ALCHEMY_DOTENV_SESSION_STAGE"),
                  yield* Config.String("ALCHEMY_PROFILE"),
                ]);
              }).pipe(Effect.orDie),
            ),
            secrets: {
              providers: [
                Secrets.DotEnv(
                  Effect.gen(function* () {
                    const stage = yield* Stage;
                    return { path: path.join(dir, `${stage}.env`) };
                  }),
                ),
              ],
            },
          },
          Config.String("ALCHEMY_DOTENV_SESSION_STAGE"),
        );
        yield* Effect.gen(function* () {
          const session = yield* open({
            entrypoint: fixtureAbsolutePath,
            stage: "prod",
            envFile,
            profile: "cli-profile",
          });
          expect(session.stack.output).toBe("prod");
          expect(
            yield* Config.String("ALCHEMY_DOTENV_SESSION_VALUE").pipe(
              Effect.provide(session.context),
            ),
          ).toBe("cli");
          const providers = yield* buildStackProviders({
            main: fixtureAbsolutePath,
            envFile: Option.some(envFile),
            profile: "cli-profile",
          });
          expect(
            yield* Config.String("ALCHEMY_DOTENV_SESSION_STAGE").pipe(
              Effect.provide(providers.context),
            ),
          ).toBe("placeholder");
          expect(observations).toEqual([
            ["cli", "prod", "cli-profile"],
            ["cli", "placeholder", "cli-profile"],
          ]);
        }).pipe(
          Effect.provideService(StackModuleLoader, {
            import: async () => ({ default: stack }),
          }),
        );
      }),
      { providers: TestLayers() },
    ));

  test("loads stack entrypoint via relative path", () =>
    expect(runFixture(fixtureRelativePath)).resolves.toBe(
      "import-stack-fixture",
    ));

  test("loads stack entrypoint via absolute path", () =>
    expect(runFixture(fixtureAbsolutePath)).resolves.toBe(
      "import-stack-fixture",
    ));

  test("memoizes an opened stack session within a command scope", async () => {
    const [first, second] = await TestCore.run(
      Effect.all([
        open({ entrypoint: fixtureAbsolutePath, stage: "test" }),
        open({ entrypoint: fixtureAbsolutePath, stage: "test" }),
      ]).pipe(
        Effect.provide(routeCacheLayer),
        Effect.provide(CliKit.layer({ input: false })),
      ),
      { providers: TestLayers() },
    );

    expect(second).toBe(first);
  });

  test("memoizes an auth registry within a command scope", async () => {
    const options = {
      main: DEFAULT_ENTRYPOINT,
      envFile: Option.none<string>(),
      profile: "default",
    };
    const [first, second] = await TestCore.run(
      Effect.all([
        collectAuthProviders(options),
        collectAuthProviders(options),
      ]).pipe(
        Effect.provide(routeCacheLayer),
        Effect.provide(CliKit.layer({ input: false })),
      ),
      { providers: TestLayers() },
    );

    expect(second).toBe(first);
  });

  test("reports a missing stack entrypoint as a user-facing error", async () => {
    const result = await TestCore.run(
      importStack(
        path.join(import.meta.dirname, "missing-alchemy.run.ts"),
      ).pipe(Effect.result),
      { providers: TestLayers() },
    );

    expect(Result.isFailure(result)).toBe(true);
    if (Result.isFailure(result)) {
      expect(result.failure._tag).toBe("StackEntrypointError");
      expect(result.failure.message).toContain("does not exist");
      expect(result.failure.message).toContain("--config <path>");
    }
  });
});
