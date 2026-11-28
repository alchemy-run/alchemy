import * as Render from "@alchemy.run/render";
import { describe, expect } from "@alchemy.run/test";
import * as Provider from "alchemy/Provider";
import * as Effect from "effect/Effect";
import { expectAllNoop, makeRenderTest } from "./common.ts";

const t = makeRenderTest();

describe("Render.Environment", { tags: ["provider:render", "live"], timeout: 120_000 }, () => {
  t.test.provider(
    "creates, plans noop, looks up, lists, updates, and destroys an Environment",
    (stack) =>
      Effect.gen(function* () {
        yield* stack.destroy();

        const prov = yield* Provider.findProvider(Render.Environment);
        const program = (version: "v1" | "v2") =>
          Effect.gen(function* () {
            const proj = yield* Render.Project("EnvProj", {
              environments: {
                base: { name: "base", protectedStatus: "unprotected" },
              },
            });
            const env = yield* Render.Environment("ExtraEnv", {
              projectId: proj.id,
              name: version === "v1" ? "qa-v1" : "qa-v2",
              protectedStatus: "unprotected",
            });
            return { proj, env };
          });

        const created = yield* stack.deploy(program("v1"));
        expect(created.env.id).toMatch(/^evm-/);
        expect(created.env.projectId).toBe(created.proj.id);
        expect(created.env.name).toBe("qa-v1");

        yield* expectAllNoop(stack, program("v1"));

        const found = yield* prov.lookup!({
          projectId: created.proj.id,
          name: "qa-v1",
        });
        expect(found?.id).toBe(created.env.id);

        const listed = yield* prov.list!();
        expect(listed.some((e) => e.id === created.env.id)).toBe(true);

        const updated = yield* stack.deploy(program("v2"));
        expect(updated.env.id).toBe(created.env.id);
        expect(updated.env.name).toBe("qa-v2");

        yield* stack.destroy();
        expect(yield* prov.lookup!({ id: created.env.id })).toBeUndefined();
      }),
    { tags: ["provider:render", "live"], timeout: 120_000 },
  );
});
