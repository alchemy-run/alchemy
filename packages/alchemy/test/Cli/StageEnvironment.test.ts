import { localStage, stage } from "@/Cli/commands/flags.ts";
import { encodeStagePathSegment, isUserStage } from "@/Stage.ts";
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
});

describe("default stages", () => {
  test("user stages reject ':'", () => {
    expect(isUserStage("live_sam")).toBe(true);
    expect(isUserStage("local_sam")).toBe(true);
    expect(isUserStage("prod")).toBe(true);
    expect(isUserStage("local:sam")).toBe(false);
    expect(encodeStagePathSegment("local_sam")).toBe("local_sam");
  });

  test.effect("deploy/destroy default to live_${USER}", () =>
    Effect.gen(function* () {
      const [, selected] = yield* stage.parse({ arguments: [], flags: {} });
      expect(selected).toBe("live_sam");
    }).pipe(Effect.provide(envLayer({ USER: "sam" }))),
  );

  test.effect("alchemy dev defaults to local_${USER}", () =>
    Effect.gen(function* () {
      const [, selected] = yield* localStage.parse({
        arguments: [],
        flags: {},
      });
      expect(selected).toBe("local_sam");
    }).pipe(Effect.provide(envLayer({ USER: "sam" }))),
  );

  test.effect("alchemy dev honors --stage", () =>
    Effect.gen(function* () {
      const [, selected] = yield* localStage.parse({
        arguments: [],
        flags: { stage: ["prod"] },
      });
      expect(selected).toBe("prod");
    }).pipe(Effect.provide(envLayer({ USER: "sam" }))),
  );

  test.effect("alchemy dev honors $STAGE", () =>
    Effect.gen(function* () {
      const [, selected] = yield* localStage.parse({
        arguments: [],
        flags: {},
      });
      expect(selected).toBe("production");
    }).pipe(Effect.provide(TestEnv)),
  );
});
