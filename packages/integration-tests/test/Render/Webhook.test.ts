import * as Render from "@alchemy.run/render";
import { describe, expect } from "@alchemy.run/test";
import * as Provider from "alchemy/Provider";
import * as Effect from "effect/Effect";
import { expectAllNoop, makeRenderTest } from "./common.ts";

const t = makeRenderTest();

describe("Render.Webhook", { tags: ["provider:render", "live"], timeout: 120_000 }, () => {
  t.test.provider(
    "creates, plans noop, looks up, lists, updates, and destroys a Webhook",
    (stack) =>
      Effect.gen(function* () {
        yield* stack.destroy();

        const prov = yield* Provider.findProvider(Render.Webhook);
        const program = (version: "v1" | "v2") =>
          Effect.gen(function* () {
            const hook = yield* Render.Webhook("Hook", {
              url: `https://example.com/alchemy-render-webhook-${version}`,
              enabled: version === "v2",
              eventFilter: version === "v1" ? ["deploy_ended"] : ["deploy_ended", "build_ended"],
            });
            return { hook };
          });

        const created = yield* stack.deploy(program("v1"));
        expect(created.hook.id).toMatch(/^whk-/);
        expect(created.hook.enabled).toBe(false);

        yield* expectAllNoop(stack, program("v1"));

        const found = yield* prov.lookup!({ name: created.hook.name });
        expect(found?.id).toBe(created.hook.id);
        expect((yield* prov.list!()).some((h) => h.id === created.hook.id)).toBe(true);

        const updated = yield* stack.deploy(program("v2"));
        expect(updated.hook.id).toBe(created.hook.id);
        expect(updated.hook.enabled).toBe(true);

        yield* stack.destroy();
        expect(yield* prov.lookup!({ id: created.hook.id })).toBeUndefined();
      }),
    { tags: ["provider:render", "live"], timeout: 120_000 },
  );
});
