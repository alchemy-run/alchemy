import * as Render from "@alchemy.run/render";
import { describe, expect } from "@alchemy.run/test";
import * as Provider from "alchemy/Provider";
import * as Effect from "effect/Effect";
import { expectAllNoop, makeRenderTest } from "./common.ts";

const t = makeRenderTest();

const skipPaid = process.env.RENDER_TEST_DEDICATED_IP !== "1";

describe("Render.DedicatedIp", { tags: ["provider:render", "live"], timeout: 120_000 }, () => {
  t.test.provider(
    "lists DedicatedIp sets without failing",
    () =>
      Effect.gen(function* () {
        const prov = yield* Provider.findProvider(Render.DedicatedIp);
        const list = yield* prov.list!();
        expect(Array.isArray(list)).toBe(true);
      }),
    { tags: ["provider:render", "live"], timeout: 60_000 },
  );

  t.test.provider.skipIf(skipPaid)(
    "creates, plans noop, and destroys DedicatedIp when RENDER_TEST_DEDICATED_IP=1",
    (stack) =>
      Effect.gen(function* () {
        yield* stack.destroy();

        const program = Render.DedicatedIp("EgressIps", {
          region: "oregon",
          description: "alchemy live test",
        });

        const prov = yield* Provider.findProvider(Render.DedicatedIp);
        const created = yield* stack.deploy(program);
        expect(created.id).toMatch(/^dip-/);

        yield* expectAllNoop(stack, program);
        yield* stack.destroy();
        expect(yield* prov.lookup!({ id: created.id })).toBeUndefined();
      }),
    { tags: ["provider:render", "live"], timeout: 120_000 },
  );
});
