import { Secrets, Stack, Stage, inMemoryState } from "@/index.ts";
import { evalStack } from "@/Stack.ts";
import * as TestCore from "@/Test/Core.ts";
import { loadConfigProvider } from "@/Util/ConfigProvider.ts";
import { describe, expect, it } from "alchemy-test";
import * as Config from "effect/Config";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Logger from "effect/Logger";
import * as PlatformError from "effect/PlatformError";
import { MinimumLogLevel } from "effect/References";
import * as Schema from "effect/Schema";

const files = (contents: Record<string, string>) =>
  FileSystem.layerNoop({
    exists: (path) => Effect.succeed(path in contents),
    readFileString: (path) =>
      path in contents
        ? Effect.succeed(contents[path])
        : Effect.fail(
            PlatformError.systemError({
              _tag: "NotFound",
              module: "FileSystem",
              method: "readFileString",
              pathOrDescriptor: path,
            }),
          ),
  });

describe("stack secrets", () => {
  it.effect("defaults to .env without mutating process.env", () => {
    const before = process.env.ALCHEMY_DOTENV_TEST_VALUE;
    return Stack(
      "dotenv-default",
      {
        providers: Layer.empty,
        state: inMemoryState(),
      },
      Config.String("ALCHEMY_DOTENV_TEST_VALUE"),
    ).pipe(
      Effect.map((stack) => {
        expect(stack.output).toBe("default");
        expect(process.env.ALCHEMY_DOTENV_TEST_VALUE).toBe(before);
      }),
      Effect.provideService(Stage, "test"),
      Effect.provide(files({ ".env": "ALCHEMY_DOTENV_TEST_VALUE=default" })),
      Effect.scoped,
    );
  });

  it.effect("ignores a missing default .env", () =>
    Stack(
      "dotenv-missing-default",
      {
        providers: Layer.empty,
        state: inMemoryState(),
      },
      Effect.succeed("ok"),
    ).pipe(
      Effect.map((stack) => expect(stack.output).toBe("ok")),
      Effect.provideService(Stage, "test"),
      Effect.provide(files({})),
      Effect.scoped,
    ),
  );

  it.effect(
    "isolates stage-specific config when stacks share a secrets layer",
    () => {
      const source = Secrets.DotEnv(
        Effect.gen(function* () {
          return { path: `${yield* Stage}.env` };
        }),
      );
      const stack = Stack(
        "dotenv-isolation",
        {
          providers: Layer.empty,
          state: inMemoryState(),
          secrets: {
            providers: [source],
          },
        },
        Config.String("ALCHEMY_DOTENV_TEST_VALUE"),
      );
      return Effect.all(
        [
          stack.pipe(Effect.provideService(Stage, "dev")),
          stack.pipe(Effect.provideService(Stage, "prod")),
        ],
        { concurrency: "unbounded" },
      ).pipe(
        Effect.map((stacks) =>
          expect(stacks.map((stack) => stack.output)).toEqual(["dev", "prod"]),
        ),
        Effect.provide(
          files({
            "dev.env": "ALCHEMY_DOTENV_TEST_VALUE=dev",
            "prod.env": "ALCHEMY_DOTENV_TEST_VALUE=prod",
          }),
        ),
        Effect.scoped,
      );
    },
  );

  it.effect(
    "loads ordered path arrays from plain and stage-based options",
    () =>
      Effect.gen(function* () {
        for (const source of [
          Secrets.DotEnv({ path: ["base.env", "prod.env"] }),
          Secrets.DotEnv(
            Effect.gen(function* () {
              return { path: ["base.env", `${yield* Stage}.env`] as const };
            }),
          ),
        ]) {
          const stack = yield* Stack(
            "dotenv-paths",
            {
              providers: Layer.empty,
              state: inMemoryState(),
              secrets: {
                providers: [source],
              },
            },
            Effect.all({
              value: Config.String("ALCHEMY_DOTENV_TEST_VALUE"),
              fallback: Config.String("ALCHEMY_DOTENV_TEST_FALLBACK"),
              empty: Config.String("ALCHEMY_DOTENV_TEST_EMPTY"),
            }),
          );
          expect(stack.output).toEqual({
            value: "prod",
            fallback: "base",
            empty: "",
          });
        }
      }).pipe(
        Effect.provideService(Stage, "prod"),
        Effect.provide(
          files({
            "base.env":
              "ALCHEMY_DOTENV_TEST_VALUE=base\nALCHEMY_DOTENV_TEST_FALLBACK=base\nALCHEMY_DOTENV_TEST_EMPTY=base",
            "prod.env":
              "ALCHEMY_DOTENV_TEST_VALUE=prod\nALCHEMY_DOTENV_TEST_EMPTY=",
          }),
        ),
        Effect.scoped,
      ),
  );

  it.effect("identifies the missing file in a path array", () =>
    Stack(
      "dotenv-missing-path",
      {
        providers: Layer.empty,
        state: inMemoryState(),
        secrets: {
          providers: [Secrets.DotEnv({ path: ["base.env", "missing.env"] })],
        },
      },
      Effect.void,
    ).pipe(
      Effect.flip,
      Effect.map((error) => expect(error.message).toContain("missing.env")),
      Effect.provideService(Stage, "test"),
      Effect.provide(files({ "base.env": "" })),
      Effect.scoped,
    ),
  );

  it.effect("explicit arrays exclude automatic and ambient dotenv values", () =>
    Effect.gen(function* () {
      for (const providers of [
        [],
        [Secrets.DotEnv({ path: [] })],
        [Secrets.DotEnv({ path: "explicit.env" })],
      ]) {
        const stack = yield* Stack(
          "dotenv-explicit",
          {
            providers: Layer.empty,
            state: inMemoryState(),
            secrets: { providers },
          },
          Config.String("ALCHEMY_DOTENV_TEST_DEFAULT").pipe(Config.option),
        );
        expect(Option.isNone(stack.output)).toBe(true);
      }
    }).pipe(
      Effect.provide(
        ConfigProvider.layer(
          ConfigProvider.fromEnv({
            env: { ALCHEMY_DOTENV_TEST_DEFAULT: "ambient" },
          }),
        ),
      ),
      Effect.provideService(Stage, "test"),
      Effect.provide(
        files({
          ".env": "ALCHEMY_DOTENV_TEST_DEFAULT=default",
          "explicit.env": "",
        }),
      ),
      Effect.scoped,
    ),
  );

  it.effect(
    "selects files by stage and preserves earlier keys and empty overrides",
    () =>
      Stack(
        "dotenv-order",
        {
          providers: Layer.empty,
          state: inMemoryState(),
          secrets: {
            providers: [
              Secrets.DotEnv({ path: "base.env" }),
              Secrets.DotEnv(
                Effect.gen(function* () {
                  const stage = yield* Stage;
                  const directory = yield* Config.String(
                    "ALCHEMY_DOTENV_TEST_DIR",
                  );
                  return { path: `${directory}/${stage}.env` };
                }),
              ),
            ],
          },
        },
        Effect.all({
          value: Config.String("ALCHEMY_DOTENV_TEST_VALUE"),
          fallback: Config.String("ALCHEMY_DOTENV_TEST_FALLBACK"),
          empty: Config.String("ALCHEMY_DOTENV_TEST_EMPTY"),
        }),
      ).pipe(
        Effect.map((stack) =>
          expect(stack.output).toEqual({
            value: "production",
            fallback: "base",
            empty: "",
          }),
        ),
        Effect.provideService(Stage, "prod"),
        Effect.provide(
          files({
            "base.env":
              "ALCHEMY_DOTENV_TEST_DIR=config\nALCHEMY_DOTENV_TEST_VALUE=base\nALCHEMY_DOTENV_TEST_FALLBACK=base\nALCHEMY_DOTENV_TEST_EMPTY=base",
            "config/prod.env":
              "ALCHEMY_DOTENV_TEST_VALUE=production\nALCHEMY_DOTENV_TEST_EMPTY=",
          }),
        ),
        Effect.scoped,
      ),
  );

  it.effect(
    "provides secrets to state, providers, and subsequent stack operations",
    () => {
      const observed: string[] = [];
      return TestCore.toEffect(
        evalStack(
          Stack(
            "dotenv-services",
            {
              state: Layer.unwrap(
                Config.String("ALCHEMY_DOTENV_TEST_VALUE").pipe(
                  Effect.map((value) => {
                    observed.push(`state:${value}`);
                  }),
                  Effect.map(() => inMemoryState()),
                  Effect.orDie,
                ),
              ),
              providers: Layer.effectDiscard(
                Config.String("ALCHEMY_DOTENV_TEST_VALUE").pipe(
                  Effect.map((value) => {
                    observed.push(`providers:${value}`);
                  }),
                  Effect.orDie,
                ),
              ),
              secrets: {
                providers: [Secrets.DotEnv({ path: "services.env" })],
              },
            },
            Config.String("ALCHEMY_DOTENV_TEST_VALUE"),
          ).pipe(
            Effect.provide(
              files({ "services.env": "ALCHEMY_DOTENV_TEST_VALUE=secret" }),
            ),
          ),
          (stack) =>
            Effect.gen(function* () {
              expect(stack.output).toBe("secret");
              expect(yield* Config.String("ALCHEMY_DOTENV_TEST_VALUE")).toBe(
                "secret",
              );
              expect(observed).toEqual(["state:secret", "providers:secret"]);
            }),
          { stage: "test" },
        ),
        { providers: Layer.empty, state: inMemoryState() },
      );
    },
  );

  it.effect("fails for an explicitly missing file", () =>
    Stack(
      "dotenv-missing-explicit",
      {
        providers: Layer.empty,
        state: inMemoryState(),
        secrets: {
          providers: [Secrets.DotEnv({ path: "missing.env" })],
        },
      },
      Effect.void,
    ).pipe(
      Effect.flip,
      Effect.map((error) => {
        expect(error._tag).toBe("ConfigError");
        expect(error.message).toContain("missing.env");
      }),
      Effect.provideService(Stage, "test"),
      Effect.provide(files({})),
      Effect.scoped,
    ),
  );

  it.effect("preserves errors from effect-based options", () =>
    Stack(
      "dotenv-options-error",
      {
        providers: Layer.empty,
        state: inMemoryState(),
        secrets: {
          providers: [Secrets.DotEnv(Effect.fail("options-error" as const))],
        },
      },
      Effect.void,
    ).pipe(
      Effect.flip,
      Effect.map((error) => {
        expect(error._tag).toBe("ConfigError");
        expect(error.message).toContain("options-error");
      }),
      Effect.provideService(Stage, "test"),
      Effect.scoped,
    ),
  );

  it.effect("accepts native ConfigProvider layers", () =>
    Stack(
      "native-config-layers",
      {
        providers: Layer.empty,
        state: inMemoryState(),
        secrets: {
          providers: [
            ConfigProvider.layer(
              ConfigProvider.fromEnv({
                env: {
                  ALCHEMY_DOTENV_TEST_VALUE: "first",
                  ALCHEMY_DOTENV_TEST_FALLBACK: "fallback",
                },
              }),
            ),
            ConfigProvider.layer(
              ConfigProvider.fromEnv({
                env: {
                  ALCHEMY_DOTENV_TEST_VALUE: "last",
                },
              }),
            ),
          ],
        },
      },
      Effect.all([
        Config.String("ALCHEMY_DOTENV_TEST_VALUE"),
        Config.String("ALCHEMY_DOTENV_TEST_FALLBACK"),
      ]),
    ).pipe(
      Effect.map((stack) => expect(stack.output).toEqual(["last", "fallback"])),
      Effect.provideService(Stage, "test"),
      Effect.scoped,
    ),
  );

  it.effect(
    "keeps process values highest during initialization and with --env-file",
    () =>
      Effect.gen(function* () {
        const key = "ALCHEMY_DOTENV_TEST_PROCESS";
        const previous = process.env[key];
        yield* Effect.acquireRelease(
          Effect.sync(() => {
            process.env[key] = "shell";
          }),
          () =>
            Effect.sync(() => {
              if (previous === undefined) delete process.env[key];
              else process.env[key] = previous;
            }),
        );
        for (const value of ["shell", ""]) {
          process.env[key] = value;
          const stack = yield* Stack(
            "dotenv-process",
            {
              providers: Layer.empty,
              state: inMemoryState(),
              secrets: {
                providers: [
                  Secrets.DotEnv({ path: "process.env" }),
                  Secrets.DotEnv(
                    Effect.gen(function* () {
                      expect(yield* Config.String(key)).toBe(value);
                      return { path: "process.env" };
                    }),
                  ),
                ],
              },
            },
            Config.String(key),
          );
          expect(stack.output).toBe(value);
          const provider = yield* loadConfigProvider(
            Option.some("process.env"),
          );
          expect(
            yield* Config.String(key).pipe(
              Effect.provide(ConfigProvider.layer(provider)),
            ),
          ).toBe(value);
          expect(process.env[key]).toBe(value);
        }
      }).pipe(
        Effect.provideService(Stage, "test"),
        Effect.provide(
          files({ "process.env": "ALCHEMY_DOTENV_TEST_PROCESS=file" }),
        ),
        Effect.scoped,
      ),
    { exclusive: true },
  );

  it.effect("validates the assembled config against the secrets schema", () =>
    Effect.gen(function* () {
      const schema = Schema.Struct({
        ALCHEMY_DOTENV_TEST_VALUE: Schema.String,
        ALCHEMY_DOTENV_TEST_PORT: Schema.Int,
      });
      const stack = (providers: ReadonlyArray<Layer.Layer<never, unknown>>) =>
        Stack(
          "dotenv-schema",
          {
            providers: Layer.empty,
            state: inMemoryState(),
            secrets: { providers, schema },
          },
          Config.String("ALCHEMY_DOTENV_TEST_VALUE"),
        );

      const complete = yield* stack([Secrets.DotEnv({ path: "complete.env" })]);
      expect(complete.output).toBe("ok");

      const incomplete = yield* stack([
        Secrets.DotEnv({ path: "incomplete.env" }),
      ]).pipe(Effect.flip);
      expect(incomplete._tag).toBe("ConfigError");
      expect(incomplete.message).toContain("ALCHEMY_DOTENV_TEST_PORT");
    }).pipe(
      Effect.provideService(Stage, "test"),
      Effect.provide(
        files({
          "complete.env":
            "ALCHEMY_DOTENV_TEST_VALUE=ok\nALCHEMY_DOTENV_TEST_PORT=8080",
          "incomplete.env": "ALCHEMY_DOTENV_TEST_VALUE=ok",
        }),
      ),
      Effect.scoped,
    ),
  );

  it.effect("logs which keys each provider loaded at debug level", () =>
    Effect.gen(function* () {
      const messages: string[] = [];
      const capture = Logger.make(({ message }) => {
        messages.push(String(message));
      });
      yield* Stack(
        "dotenv-logging",
        {
          providers: Layer.empty,
          state: inMemoryState(),
          secrets: {
            providers: [
              Secrets.DotEnv({ path: "base.env" }),
              Secrets.DotEnv({ path: ["prod.env", "empty.env"] }),
            ],
            schema: Schema.Struct({ ALCHEMY_DOTENV_TEST_VALUE: Schema.String }),
          },
        },
        Effect.void,
      ).pipe(
        Effect.provide(Logger.layer([capture])),
        Effect.provideService(MinimumLogLevel, "Debug"),
      );
      expect(messages).toEqual([
        "Loaded 2 secrets from dotenv (base.env): ALCHEMY_DOTENV_TEST_FALLBACK, ALCHEMY_DOTENV_TEST_VALUE",
        "Loaded 1 secrets from dotenv (prod.env, empty.env): ALCHEMY_DOTENV_TEST_VALUE",
        "Stack secrets satisfy the declared schema",
      ]);
      // Keys only, never values.
      expect(messages.join("\n")).not.toContain("hunter2");
    }).pipe(
      Effect.provideService(Stage, "test"),
      Effect.provide(
        files({
          "base.env":
            "ALCHEMY_DOTENV_TEST_VALUE=hunter2\nALCHEMY_DOTENV_TEST_FALLBACK=base",
          "prod.env": "ALCHEMY_DOTENV_TEST_VALUE=hunter2",
          "empty.env": "",
        }),
      ),
      Effect.scoped,
    ),
  );
});
