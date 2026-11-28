import * as Render from "@alchemy.run/render";
import { describe, expect } from "@alchemy.run/test";
import * as Provider from "alchemy/Provider";
import * as Effect from "effect/Effect";
import { expectAllNoop, makeRenderTest } from "./common.ts";

const t = makeRenderTest();

describe("Render.EnvGroupLink", { tags: ["provider:render", "live"], timeout: 180_000 }, () => {
  t.test.provider(
    "links an EnvGroup to a WebService, plans noop, updates, and destroys cleanly",
    (stack) =>
      Effect.gen(function* () {
        yield* stack.destroy();
        const groupProv = yield* Provider.findProvider(Render.EnvGroup);

        const program = (linkValue: string) =>
          Effect.gen(function* () {
            const proj = yield* Render.Project("LinkProj", {
              environments: {
                staging: { name: "staging", protectedStatus: "unprotected" },
              },
            });
            const group = yield* Render.EnvGroup("LinkGroup", {
              environmentId: proj.environments.staging.id,
              envVars: { SHARED_CONFIG: linkValue },
            });
            const web = yield* Render.WebService("LinkWeb", {
              plan: "free",
              region: "oregon",
              environmentId: proj.environments.staging.id,
              skipDeployAfterUpdate: true,
              runtimeSource: {
                image: {
                  imagePath: "docker.io/nginxdemos/hello",
                  tag: "plain-text",
                },
              },
            });
            const link = yield* Render.EnvGroupLink("Link", {
              envGroupId: group.id,
              serviceIds: [web.id],
            });
            return { proj, group, web, link };
          });

        const created = yield* stack.deploy(program("one"));
        expect(created.link.serviceIds).toEqual([created.web.id]);

        yield* expectAllNoop(stack, program("one"));

        const updated = yield* stack.deploy(program("two"));
        expect(updated.link.serviceIds).toEqual([updated.web.id]);

        yield* stack.destroy();
        expect(yield* groupProv.lookup!({ id: created.group.id })).toBeUndefined();
      }),
    { tags: ["provider:render", "live"], timeout: 180_000 },
  );
});
