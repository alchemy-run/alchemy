import {
  applyLocalDevStage,
  localDevStageFromUser,
  rejectedDevStage,
  stage,
} from "@/Cli/commands/flags.ts";
import {
  encodeStagePathSegment,
  isLocalDevStage,
  isUserStage,
  localDevStage,
  sanitizeLocalDevUser,
} from "@/Stage.ts";
import { PlatformServices } from "@/Util/PlatformServices.ts";
import { describe, expect, test } from "alchemy-test";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";

const envLayer = (env: Record<string, string>) =>
  Layer.mergeAll(
    PlatformServices,
    ConfigProvider.layer(ConfigProvider.fromEnv({ env })),
  );

const TestEnv = envLayer({ STAGE: "production", USER: "name" });

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

  test.effect("rejects a $STAGE value containing ':'", () =>
    Effect.gen(function* () {
      const exit = yield* stage
        .parse({ arguments: [], flags: {} })
        .pipe(Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
    }).pipe(Effect.provide(envLayer({ STAGE: "local:sam", USER: "sam" }))),
  );

  test.effect("rejects --stage local:sam", () =>
    Effect.gen(function* () {
      const exit = yield* stage
        .parse({ arguments: [], flags: { stage: ["local:sam"] } })
        .pipe(Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
    }).pipe(Effect.provide(envLayer({ USER: "sam" }))),
  );

  test.effect("defaults to dev_${USER} when STAGE is unset", () =>
    Effect.gen(function* () {
      const [, selected] = yield* stage.parse({ arguments: [], flags: {} });
      expect(selected).toBe("dev_sam");
    }).pipe(Effect.provide(envLayer({ USER: "sam" }))),
  );
});

describe("local-dev stage", () => {
  test("local:<user> is not a user stage and colon is reserved", () => {
    expect(isUserStage("dev_sam")).toBe(true);
    expect(isUserStage("prod")).toBe(true);
    expect(isUserStage("local:sam")).toBe(false);
    expect(isLocalDevStage("local:sam")).toBe(true);
    expect(isLocalDevStage("dev_sam")).toBe(false);
    expect(sanitizeLocalDevUser("Sam.Goodwin")).toBe("sam_goodwin");
    expect(localDevStage("Sam")).toBe("local:sam");
    expect(encodeStagePathSegment("local:sam")).toBe("local%3Asam");
    expect(encodeStagePathSegment("dev_sam")).toBe("dev_sam");
  });

  test.effect("applyLocalDevStage rewrites to local:<user>", () =>
    Effect.gen(function* () {
      const rewritten = yield* applyLocalDevStage({
        stage: "production",
        dev: true,
      });
      expect(rewritten.stage).toBe("local:name");
    }).pipe(Effect.provide(TestEnv)),
  );

  test.effect("applyLocalDevStage is a no-op without --dev", () =>
    Effect.gen(function* () {
      const same = yield* applyLocalDevStage({
        stage: "production",
        dev: false,
      });
      expect(same.stage).toBe("production");
    }).pipe(Effect.provide(TestEnv)),
  );

  test.effect("localDevStageFromUser folds the username", () =>
    Effect.gen(function* () {
      expect(yield* localDevStageFromUser).toBe("local:name");
    }).pipe(Effect.provide(TestEnv)),
  );

  test.effect("alchemy dev --stage is parsed as an explicit override", () =>
    Effect.gen(function* () {
      const [, explicit] = yield* rejectedDevStage.parse({
        arguments: [],
        flags: { stage: ["prod"] },
      });
      expect(explicit).toBe("prod");
      const [, omitted] = yield* rejectedDevStage.parse({
        arguments: [],
        flags: {},
      });
      expect(omitted).toBeUndefined();
    }).pipe(Effect.provide(TestEnv)),
  );
});
