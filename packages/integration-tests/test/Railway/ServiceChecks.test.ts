import { serviceCheckSuites } from "@alchemy.run/railway/ServiceChecks";
import { describe, expect, it } from "@alchemy.run/test";
import * as Effect from "effect/Effect";

describe(
  "Railway service wait for CI",
  { tags: ["unit", "provider:railway", "provider:railway:service", "local"] },
  () => {
    it.effect("reads source.checkSuites and treats an absent key as off", () =>
      Effect.gen(function* () {
        const config = {
          services: {
            on: { source: { repo: "acme/web", checkSuites: true } },
            off: { source: { repo: "acme/web", checkSuites: false } },
            unset: { source: { repo: "acme/web" } },
            image: { source: { image: "hashicorp/http-echo" } },
          },
        };
        expect(yield* serviceCheckSuites(config, "on")).toBe(true);
        expect(yield* serviceCheckSuites(config, "off")).toBe(false);
        expect(yield* serviceCheckSuites(config, "unset")).toBe(false);
        expect(yield* serviceCheckSuites(config, "image")).toBe(false);
        expect(yield* serviceCheckSuites(config, "missing")).toBe(false);
      }),
    );

    it.effect("reads off when the config has no source", () =>
      Effect.gen(function* () {
        for (const config of [
          {},
          { services: null },
          { services: { on: null } },
          { services: { on: { source: null } } },
          { services: { on: { source: { checkSuites: null } } } },
        ]) {
          expect(yield* serviceCheckSuites(config, "on")).toBe(false);
        }
      }),
    );

    it.effect("fails on a config whose shape Railway changed", () =>
      Effect.gen(function* () {
        for (const config of [
          { services: [] },
          { services: { on: { source: { checkSuites: "yes" } } } },
        ]) {
          const error = yield* serviceCheckSuites(config, "on").pipe(Effect.flip);
          expect(error._tag).toEqual("SchemaError");
        }
      }),
    );
  },
);
