import { stage } from "@/Cli/commands/_shared.ts";
import { PlatformServices } from "@/Util/PlatformServices.ts";
import { describe, expect, test } from "alchemy-test";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";

const testEnv = (env: Record<string, string>) =>
  Layer.mergeAll(
    PlatformServices,
    ConfigProvider.layer(ConfigProvider.fromEnv({ env })),
  );

const TestEnv = testEnv({ STAGE: "production", USER: "name" });

describe("STAGE environment variable", () => {
  test.effect("takes precedence over the user default", () =>
    Effect.gen(function* () {
      const [, selected] = yield* stage.parse({ arguments: [], flags: {} });

      expect(selected).toBe("production");
    }).pipe(Effect.provide(TestEnv)),
  );

  test.effect("yields to an explicit --stage flag", () =>
    Effect.gen(function* () {
      const [, selected] = yield* stage.parse({
        arguments: [],
        flags: { stage: ["preview"] },
      });

      expect(selected).toBe("preview");
    }).pipe(Effect.provide(TestEnv)),
  );

  test.effect("rejects an invalid value", () =>
    Effect.gen(function* () {
      const result = yield* Effect.result(
        stage.parse({ arguments: [], flags: {} }),
      );

      expect(Result.isFailure(result)).toBe(true);
      if (Result.isFailure(result)) {
        expect(result.failure._tag).toBe("UserError");
        if (result.failure._tag === "UserError") {
          expect(String(result.failure.cause)).toContain("STAGE");
        }
      }
    }).pipe(Effect.provide(testEnv({ STAGE: "../production" }))),
  );
});

describe("default stage", () => {
  test.effect("uses a safe form of the user name", () =>
    Effect.gen(function* () {
      const [, selected] = yield* stage.parse({ arguments: [], flags: {} });

      expect(selected).toMatch(/^dev-user-name-[a-z2-7]{8}$/);
    }).pipe(Effect.provide(testEnv({ USER: "User Name" }))),
  );
});
