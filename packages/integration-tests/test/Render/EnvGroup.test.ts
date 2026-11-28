import * as Render from "@alchemy.run/render";
import { describe, expect } from "@alchemy.run/test";
import * as Provider from "alchemy/Provider";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { expectAllNoop, makeRenderTest } from "./common.ts";

const t = makeRenderTest();

describe("Render.EnvGroup", { tags: ["provider:render", "live"], timeout: 120_000 }, () => {
  t.test.provider(
    "creates, preserves generated secrets, looks up, lists, updates, and destroys an EnvGroup",
    (stack) =>
      Effect.gen(function* () {
        yield* stack.destroy();

        const prov = yield* Provider.findProvider(Render.EnvGroup);
        const program = (version: "v1" | "v2") =>
          Effect.gen(function* () {
            const proj = yield* Render.Project("EgProj", {
              environments: {
                staging: { name: "staging", protectedStatus: "unprotected" },
              },
            });
            const group = yield* Render.EnvGroup("Group", {
              environmentId: proj.environments.staging.id,
              envVars: {
                ALCHEMY_LIVE_TEST: version,
                GENERATED_TOKEN: { generateValue: true },
              },
              secretFiles: {
                "config.json": JSON.stringify({ version }),
              },
            });
            return { proj, group };
          });

        const created = yield* stack.deploy(program("v1"));
        expect(created.group.id).toMatch(/^evg-/);
        expect(Redacted.value(created.group.envVars.ALCHEMY_LIVE_TEST)).toBe("v1");
        const initialGenerated = Redacted.value(created.group.envVars.GENERATED_TOKEN);
        expect(initialGenerated.length).toBeGreaterThan(0);

        yield* expectAllNoop(stack, program("v1"));

        const found = yield* prov.lookup!({ name: created.group.name });
        expect(found?.id).toBe(created.group.id);
        expect((yield* prov.list!()).some((g) => g.id === created.group.id)).toBe(true);

        const updated = yield* stack.deploy(program("v2"));
        expect(updated.group.id).toBe(created.group.id);
        expect(Redacted.value(updated.group.envVars.ALCHEMY_LIVE_TEST)).toBe("v2");
        expect(Redacted.value(updated.group.envVars.GENERATED_TOKEN)).toBe(initialGenerated);

        yield* stack.destroy();
        expect(yield* prov.lookup!({ id: created.group.id })).toBeUndefined();
      }),
    { tags: ["provider:render", "live"], timeout: 120_000 },
  );
});
