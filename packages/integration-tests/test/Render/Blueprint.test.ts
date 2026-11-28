import * as Render from "@alchemy.run/render";
import { describe, expect } from "@alchemy.run/test";
import * as Provider from "alchemy/Provider";
import * as Effect from "effect/Effect";
import { makeRenderTest } from "./common.ts";

const t = makeRenderTest();

const blueprintId = process.env.RENDER_TEST_BLUEPRINT_ID;

describe("Render.Blueprint", { tags: ["provider:render", "live"], timeout: 120_000 }, () => {
  t.test.provider(
    "lists Blueprints and validates render.yaml via POST /v1/blueprints/validate",
    () =>
      Effect.gen(function* () {
        const prov = yield* Provider.findProvider(Render.Blueprint);
        const list = yield* prov.list!();
        expect(Array.isArray(list)).toBe(true);

        const validated = yield* Render.validateBlueprint({
          yaml: [
            "services:",
            "  - type: web",
            "    name: alchemy-validate-probe",
            "    runtime: node",
            "    buildCommand: npm install",
            "    startCommand: node index.js",
            "",
          ].join("\n"),
        });
        expect(validated.valid).not.toBe(false);
      }),
    { tags: ["provider:render", "live"], timeout: 60_000 },
  );

  t.test.provider.skipIf(!blueprintId)(
    "adopts and looks up a connected Blueprint when RENDER_TEST_BLUEPRINT_ID is set",
    () =>
      Effect.gen(function* () {
        const prov = yield* Provider.findProvider(Render.Blueprint);
        const bp = yield* prov.lookup!({ id: blueprintId! });
        expect(bp?.id).toBe(blueprintId);
      }),
    { tags: ["provider:render", "live"], timeout: 60_000 },
  );
});
