import * as Render from "@alchemy.run/render";
import { describe, expect } from "@alchemy.run/test";
import * as Provider from "alchemy/Provider";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { expectAllNoop, makeRenderTest } from "./common.ts";

const t = makeRenderTest();

describe("Render.PrivateService", { tags: ["provider:render", "live"], timeout: 180_000 }, () => {
  t.test.provider(
    "creates, plans noop, looks up, lists, updates, and destroys a PrivateService",
    (stack) =>
      Effect.gen(function* () {
        yield* stack.destroy();

        const prov = yield* Provider.findProvider(Render.PrivateService);
        const program = (version: "v1" | "v2") =>
          Effect.gen(function* () {
            const proj = yield* Render.Project("PrivProj", {
              environments: {
                staging: { name: "staging", protectedStatus: "unprotected" },
              },
            });
            const priv = yield* Render.PrivateService("Priv", {
              plan: "starter",
              region: "oregon",
              environmentId: proj.environments.staging.id,
              envVars: { PRIV_TAG: version },
              skipDeployAfterUpdate: true,
              runtimeSource: {
                image: {
                  imagePath: "docker.io/nginxdemos/hello",
                  tag: "plain-text",
                },
              },
            });
            return { proj, priv };
          });

        const created = yield* stack.deploy(program("v1"));
        expect(created.priv.id).toMatch(/^srv-/);
        expect(Redacted.value(created.priv.envVars.PRIV_TAG)).toBe("v1");

        yield* expectAllNoop(stack, program("v1"));

        const found = yield* prov.lookup!({ id: created.priv.id });
        expect(found?.id).toBe(created.priv.id);
        expect((yield* prov.list!()).some((s) => s.id === created.priv.id)).toBe(true);

        const updated = yield* stack.deploy(program("v2"));
        expect(updated.priv.id).toBe(created.priv.id);
        expect(Redacted.value(updated.priv.envVars.PRIV_TAG)).toBe("v2");

        yield* stack.destroy();
        expect(yield* prov.lookup!({ id: created.priv.id })).toBeUndefined();
      }),
    { tags: ["provider:render", "live"], timeout: 180_000 },
  );
});
