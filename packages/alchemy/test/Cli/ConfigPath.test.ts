import { UserInputError } from "@/Cli/commands/errors.ts";
import {
  resolveConfig,
  targets,
  validateTargetOptions,
} from "@/Cli/commands/flags.ts";
import { DevOptions } from "@/Cli/DevOptions.ts";
import * as Stacks from "@/Alchemist/routes/stack.ts";
import * as Alchemist from "@/Alchemist/Runtime.ts";
import { PlatformServices } from "@/Util/PlatformServices.ts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Exit from "effect/Exit";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import { describe, expect, it } from "alchemy-test";

describe("stack command config paths", () => {
  it.effect("uses the positional config path", () =>
    Effect.gen(function* () {
      const args = yield* resolveConfig({
        config: undefined,
        configPath: "infra.ts",
      });
      expect(args.main).toBe("infra.ts");
    }),
  );

  it.effect("uses --config", () =>
    Effect.gen(function* () {
      const args = yield* resolveConfig({
        config: "infra.ts",
        configPath: undefined,
      });
      expect(args.main).toBe("infra.ts");
    }),
  );

  it.effect("defaults to alchemy.run.ts", () =>
    Effect.gen(function* () {
      const args = yield* resolveConfig({
        config: undefined,
        configPath: undefined,
      });
      expect(args.main).toBe("alchemy.run.ts");
    }),
  );

  it.effect("rejects using the positional path and --config together", () =>
    Effect.gen(function* () {
      const result = yield* resolveConfig({
        config: "flag.ts",
        configPath: "positional.ts",
      }).pipe(Effect.result);

      expect(Result.isFailure(result)).toBe(true);
      if (Result.isFailure(result)) {
        expect(result.failure).toBeInstanceOf(UserInputError);
        expect(result.failure.message).toContain("not both");
      }
    }),
  );
});

describe("stack target options", () => {
  for (const [values, expected] of [
    [[], undefined],
    [
      ["Branch,Password", "Namespace/Worker"],
      ["Branch", "Password", "Namespace/Worker"],
    ],
    [[""], [""]],
    [["Branch,"], ["Branch", ""]],
  ] as const) {
    it.effect(
      `parses repeated comma-separated selectors ${JSON.stringify(values)}`,
      () =>
        Effect.gen(function* () {
          const [, parsed] = yield* targets.parse({
            arguments: [],
            flags: values.length ? { target: [...values] } : {},
          });
          expect(parsed).toEqual(expected);
        }).pipe(Effect.provide(PlatformServices)),
    );
  }

  it.effect("retains targets through the dev supervisor JSON roundtrip", () =>
    Effect.gen(function* () {
      for (const selected of [
        undefined,
        [],
        ["Branch", "Namespace/Password"],
      ]) {
        const options = {
          main: "alchemy.run.ts",
          stage: "test",
          envFile: Option.none(),
          force: false,
          targets: selected,
        };
        const wire = yield* Schema.encodeEffect(DevOptions)(options);
        const decoded = yield* Schema.decodeUnknownEffect(DevOptions)(
          JSON.parse(JSON.stringify(wire)),
        );
        expect(decoded.targets).toEqual(selected);
      }
    }),
  );

  for (const combination of [{ destroy: true }, { detectDrift: true }]) {
    it.effect(`rejects targeting with ${JSON.stringify(combination)}`, () =>
      Effect.gen(function* () {
        const result = yield* validateTargetOptions({
          targets: ["Branch"],
          ...combination,
        }).pipe(Effect.result);
        expect(Result.isFailure(result)).toBe(true);
        yield* validateTargetOptions(combination);
      }),
    );
  }

  it.effect(
    "rejects targeted Alchemist destroy before opening a stack session",
    () =>
      Effect.gen(function* () {
        const exit = yield* Stacks.plan({
          target: { entrypoint: "does-not-exist.ts", stage: "test" },
          operation: "destroy",
          targets: ["Branch"],
        }).pipe(Effect.exit);
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit))
          expect(Cause.pretty(exit.cause)).toContain(
            "Targeted destroy is not supported",
          );
      }).pipe(Effect.provide(Alchemist.layer()), Effect.scoped),
  );
});
