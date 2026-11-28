import * as Render from "@alchemy.run/render";
import { describe, expect } from "@alchemy.run/test";
import * as Provider from "alchemy/Provider";
import * as Effect from "effect/Effect";
import { expectAllNoop, makeRenderTest } from "./common.ts";

const t = makeRenderTest();

describe("Render.Project", { tags: ["provider:render", "live"], timeout: 120_000 }, () => {
  t.test.provider(
    "creates, plans noop, looks up, lists, updates, and destroys a Project",
    (stack) =>
      Effect.gen(function* () {
        yield* stack.destroy();

        const prov = yield* Provider.findProvider(Render.Project);
        const program = (version: "v1" | "v2") =>
          Effect.gen(function* () {
            const proj = yield* Render.Project("Proj", {
              environments: {
                staging: { name: "staging", protectedStatus: "unprotected" },
                ...(version === "v2"
                  ? { preview: { name: "preview", protectedStatus: "unprotected" } }
                  : {}),
              },
            });
            return { proj };
          });

        const created = yield* stack.deploy(program("v1"));
        expect(created.proj.id).toMatch(/^prj-/);
        expect(created.proj.environments.staging.id).toMatch(/^evm-/);

        yield* expectAllNoop(stack, program("v1"));

        const foundById = yield* prov.lookup!({ id: created.proj.id });
        const foundByName = yield* prov.lookup!({ name: created.proj.name });
        expect(foundById?.id).toBe(created.proj.id);
        expect(foundByName?.id).toBe(created.proj.id);

        const listed = yield* prov.list!();
        expect(listed.some((p) => p.id === created.proj.id)).toBe(true);

        const updated = yield* stack.deploy(program("v2"));
        expect(updated.proj.id).toBe(created.proj.id);
        expect(updated.proj.environments.preview.id).toMatch(/^evm-/);

        yield* stack.destroy();
        expect(yield* prov.lookup!({ id: created.proj.id })).toBeUndefined();
      }),
    { tags: ["provider:render", "live"], timeout: 120_000 },
  );
});
