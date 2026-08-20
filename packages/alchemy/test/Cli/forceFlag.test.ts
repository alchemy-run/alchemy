/**
 * The `--force` flag's parser contract.
 *
 * `--force` is a switch that ALSO accepts an inline selection, which Effect's
 * CLI has no first-class support for: `_shared.ts` builds it from a string
 * primitive wearing the `Boolean` tag the parser dispatches on. That's an
 * internal contract of `effect/unstable/cli`, so these tests pin every shape
 * the flag has to keep supporting — an effect upgrade that changes the
 * dispatch fails here instead of silently turning `alchemy deploy --force
 * alchemy.run.ts` into "unknown file".
 */
import { force, parseForceValue } from "@/Cli/commands/_shared";
import { ExecStackOptions } from "@/Cli/commands/deploy";
import { PlatformServices } from "@/Util/PlatformServices";
import { describe, expect, it, test } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Argument from "effect/unstable/cli/Argument";
import * as Command from "effect/unstable/cli/Command";
import * as Schema from "effect/Schema";

const parse = (
  argv: ReadonlyArray<string>,
): Effect.Effect<{ force: unknown; main: string }> =>
  Effect.gen(function* () {
    let parsed: { force: unknown; main: string } | undefined;
    const command = Command.make(
      "deploy",
      {
        force,
        main: Argument.string("main").pipe(
          Argument.withDefault("alchemy.run.ts"),
        ),
      },
      (args) => Effect.sync(() => void (parsed = args as any)),
    );
    yield* Command.runWith(command, {
      version: "test",
      renderErrors: false,
    })(argv);
    return parsed!;
  }).pipe(Effect.provide(PlatformServices), Effect.scoped) as Effect.Effect<{
    force: unknown;
    main: string;
  }>;

describe("--force parsing", () => {
  it.effect("absent -> false", () =>
    Effect.gen(function* () {
      expect((yield* parse([])).force).toBe(false);
    }),
  );

  it.effect("bare --force -> true (the whole stack)", () =>
    Effect.gen(function* () {
      expect((yield* parse(["--force"])).force).toBe(true);
    }),
  );

  it.effect("--force=A,B -> the selection", () =>
    Effect.gen(function* () {
      expect((yield* parse(["--force=Seed,Api"])).force).toEqual([
        "Seed",
        "Api",
      ]);
    }),
  );

  it.effect("--force=A -> a one-entry selection, FQNs included", () =>
    Effect.gen(function* () {
      expect((yield* parse(["--force=Backend/Seed"])).force).toEqual([
        "Backend/Seed",
      ]);
    }),
  );

  it.effect("bare --force never swallows the positional main", () =>
    Effect.gen(function* () {
      const args = yield* parse(["--force", "infra/app.ts"]);
      expect(args.force).toBe(true);
      expect(args.main).toBe("infra/app.ts");
    }),
  );

  it.effect(
    "the selection form composes with the positional main, either order",
    () =>
      Effect.gen(function* () {
        expect(yield* parse(["--force=Seed", "infra/app.ts"])).toMatchObject({
          force: ["Seed"],
          main: "infra/app.ts",
        });
        expect(yield* parse(["infra/app.ts", "--force=Seed"])).toMatchObject({
          force: ["Seed"],
          main: "infra/app.ts",
        });
      }),
  );

  it.effect("--no-force and --force=false -> false", () =>
    Effect.gen(function* () {
      expect((yield* parse(["--no-force"])).force).toBe(false);
      expect((yield* parse(["--force=false"])).force).toBe(false);
      expect((yield* parse(["--force=true"])).force).toBe(true);
    }),
  );
});

describe("parseForceValue", () => {
  test("boolean literals", () => {
    expect(parseForceValue("true")).toBe(true);
    expect(parseForceValue("yes")).toBe(true);
    expect(parseForceValue("false")).toBe(false);
    expect(parseForceValue("off")).toBe(false);
  });

  test("selections are trimmed and emptied entries dropped", () => {
    expect(parseForceValue("Seed, Api ,")).toEqual(["Seed", "Api"]);
    expect(parseForceValue(" , ")).toBe(false);
  });
});

describe("ExecStackOptions", () => {
  it.effect(
    "a selection survives the JSON round-trip into the dev child process",
    () =>
      Effect.gen(function* () {
        // `alchemy dev` re-execs itself with the options encoded into
        // ALCHEMY_EXEC_OPTIONS, so the selection has to survive
        // encode -> JSON -> decode intact.
        const encoded = yield* Schema.encodeEffect(ExecStackOptions)({
          main: "alchemy.run.ts",
          stage: "dev",
          force: ["Seed", "Backend/Api"],
          dev: true,
        } as any);
        const decoded = Schema.decodeSync(ExecStackOptions)(
          JSON.parse(JSON.stringify(encoded)),
        );
        expect(decoded.force).toEqual(["Seed", "Backend/Api"]);

        const bool = Schema.decodeSync(ExecStackOptions)(
          JSON.parse(
            JSON.stringify(
              yield* Schema.encodeEffect(ExecStackOptions)({
                main: "alchemy.run.ts",
                stage: "dev",
                force: true,
              } as any),
            ),
          ),
        );
        expect(bool.force).toBe(true);
      }),
  );
});
