import * as Render from "@alchemy.run/render";
import { describe, expect } from "@alchemy.run/test";
import * as Provider from "alchemy/Provider";
import * as Effect from "effect/Effect";
import { expectAllNoop, makeRenderTest } from "./common.ts";

const t = makeRenderTest();

describe("Render.ServicePreview", { tags: ["provider:render", "live"], timeout: 240_000 }, () => {
  t.test.provider(
    "creates a preview from a base image-backed WebService, plans noop, updates imagePath, and destroys",
    (stack) =>
      Effect.gen(function* () {
        yield* stack.destroy();
        const prov = yield* Provider.findProvider(Render.ServicePreview);

        const program = (tag: string) =>
          Effect.gen(function* () {
            const proj = yield* Render.Project("PrevProj", {
              environments: {
                staging: { name: "staging", protectedStatus: "unprotected" },
              },
            });
            const base = yield* Render.WebService("BaseSvc", {
              plan: "starter",
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
            const preview = yield* Render.ServicePreview("Preview", {
              baseServiceId: base.id,
              imagePath: `docker.io/nginxdemos/hello:${tag}`,
              plan: "starter",
            });
            return { proj, base, preview };
          });

        const created = yield* stack.deploy(program("plain-text"));
        expect(created.preview.id).toMatch(/^srv-/);
        expect(created.preview.baseServiceId).toBe(created.base.id);

        yield* expectAllNoop(stack, program("plain-text"));

        const found = yield* prov.lookup!({ id: created.preview.id });
        expect(found?.id).toBe(created.preview.id);

        const updated = yield* stack.deploy(program("latest"));
        expect(updated.preview.id).toBe(created.preview.id);

        yield* stack.destroy();
        expect(yield* prov.lookup!({ id: created.preview.id })).toBeUndefined();
      }),
    { tags: ["provider:render", "live"], timeout: 240_000 },
  );
});
