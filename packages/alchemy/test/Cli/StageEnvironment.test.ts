import { devStage, stage } from "@/Cli/commands/flags.ts";
import { PlatformServices } from "@/Util/PlatformServices.ts";
import { describe, expect, test } from "alchemy-test";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
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
});

describe("default stages", () => {
  test.effect("deploy/destroy default to live_${USER}", () =>
    Effect.gen(function* () {
      const [, selected] = yield* stage.parse({ arguments: [], flags: {} });
      expect(selected).toBe("live_sam");
    }).pipe(Effect.provide(envLayer({ USER: "sam" }))),
  );

  test.effect("alchemy dev defaults to dev_${USER}", () =>
    Effect.gen(function* () {
      const [, selected] = yield* devStage.parse({
        arguments: [],
        flags: {},
      });
      expect(selected).toBe("dev_sam");
    }).pipe(Effect.provide(envLayer({ USER: "sam" }))),
  );

  test.effect("alchemy dev honors --stage", () =>
    Effect.gen(function* () {
      const [, selected] = yield* devStage.parse({
        arguments: [],
        flags: { stage: ["prod"] },
      });
      expect(selected).toBe("prod");
    }).pipe(Effect.provide(envLayer({ USER: "sam" }))),
  );

  test.effect("alchemy dev honors $STAGE", () =>
    Effect.gen(function* () {
      const [, selected] = yield* devStage.parse({
        arguments: [],
        flags: {},
      });
      expect(selected).toBe("production");
    }).pipe(Effect.provide(TestEnv)),
  );
});
