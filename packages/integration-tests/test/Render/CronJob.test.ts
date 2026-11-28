import * as Render from "@alchemy.run/render";
import { describe, expect } from "@alchemy.run/test";
import * as Provider from "alchemy/Provider";
import * as Effect from "effect/Effect";
import { expectAllNoop, makeRenderTest } from "./common.ts";

const t = makeRenderTest();

describe("Render.CronJob", { tags: ["provider:render", "live"], timeout: 180_000 }, () => {
  t.test.provider(
    "creates, plans noop, looks up, lists, updates schedule, and destroys a CronJob",
    (stack) =>
      Effect.gen(function* () {
        yield* stack.destroy();

        const prov = yield* Provider.findProvider(Render.CronJob);
        const program = (version: "v1" | "v2") =>
          Effect.gen(function* () {
            const proj = yield* Render.Project("CronProj", {
              environments: {
                staging: { name: "staging", protectedStatus: "unprotected" },
              },
            });
            const cron = yield* Render.CronJob("Cron", {
              plan: "starter",
              region: "oregon",
              environmentId: proj.environments.staging.id,
              schedule: version === "v1" ? "0 0 * * *" : "30 2 * * *",
              skipDeployAfterUpdate: true,
              runtimeSource: {
                image: {
                  imagePath: "docker.io/nginxdemos/hello",
                  tag: "plain-text",
                },
              },
            });
            return { proj, cron };
          });

        const created = yield* stack.deploy(program("v1"));
        expect(created.cron.id).toMatch(/^crn-/);
        expect(created.cron.schedule).toBe("0 0 * * *");

        yield* expectAllNoop(stack, program("v1"));

        const found = yield* prov.lookup!({ id: created.cron.id });
        expect(found?.id).toBe(created.cron.id);
        expect((yield* prov.list!()).some((s) => s.id === created.cron.id)).toBe(true);

        const updated = yield* stack.deploy(program("v2"));
        expect(updated.cron.id).toBe(created.cron.id);
        expect(updated.cron.schedule).toBe("30 2 * * *");

        yield* stack.destroy();
        expect(yield* prov.lookup!({ id: created.cron.id })).toBeUndefined();
      }),
    { tags: ["provider:render", "live"], timeout: 180_000 },
  );
});
