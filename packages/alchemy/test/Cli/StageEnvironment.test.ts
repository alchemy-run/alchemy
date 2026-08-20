import { stage } from "@/Cli/commands/_shared.ts";
import { PlatformServices } from "@/Util/PlatformServices.ts";
import { describe, expect, test } from "alchemy-test";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

const testEnv = (env: Record<string, string>) =>
  Layer.mergeAll(
    PlatformServices,
    ConfigProvider.layer(ConfigProvider.fromEnv({ env })),
  );

const parseStage = (env: Record<string, string>, flag?: string) =>
  stage
    .parse({
      arguments: [],
      flags: flag === undefined ? {} : { stage: [flag] },
    })
    .pipe(Effect.provide(testEnv(env)));

describe("stage", () => {
  test.effect("STAGE takes precedence over the user default", () =>
    Effect.gen(function* () {
      const [, selected] = yield* parseStage({
        STAGE: "Production_STAGE",
        USER: "name",
      });

      expect(selected).toBe("Production_STAGE");
    }),
  );

  test.effect("--stage takes precedence over STAGE", () =>
    Effect.gen(function* () {
      const [, selected] = yield* parseStage(
        { STAGE: "Production_STAGE", USER: "name" },
        "Preview_STAGE",
      );

      expect(selected).toBe("Preview_STAGE");
    }),
  );

  test.effect("does not validate STAGE when --stage is set", () =>
    Effect.gen(function* () {
      const [, selected] = yield* parseStage(
        { STAGE: "../production", USER: "name" },
        "Preview_STAGE",
      );

      expect(selected).toBe("Preview_STAGE");
    }),
  );

  test.effect("rejects an invalid --stage", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(parseStage({}, "../preview"));

      expect(error._tag).toBe("InvalidValue");
      if (error._tag === "InvalidValue") {
        expect(error.option).toBe("stage");
      }
    }),
  );

  test.effect("rejects an invalid STAGE", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(parseStage({ STAGE: "../production" }));

      expect(error._tag).toBe("UserError");
      if (error._tag === "UserError") {
        expect(String(error.cause)).toContain("STAGE");
      }
    }),
  );

  test.effect("uses USER before USERNAME for the default", () =>
    Effect.gen(function* () {
      const [, selected] = yield* parseStage({
        USER: "User Name",
        USERNAME: "windows-user",
      });

      expect(selected).toBe("dev-user-name-vfu5at");
    }),
  );

  test.effect("falls back to USERNAME for the default", () =>
    Effect.gen(function* () {
      const [, selected] = yield* parseStage({ USERNAME: "windows-user" });

      expect(selected).toBe("dev-windows-user");
    }),
  );

  test.effect("falls back to unknown when no user name is available", () =>
    Effect.gen(function* () {
      const [, selected] = yield* parseStage({});

      expect(selected).toBe("dev-unknown");
    }),
  );
});
