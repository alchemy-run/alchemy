import * as Render from "@alchemy.run/render";
import { describe, expect } from "@alchemy.run/test";
import * as Provider from "alchemy/Provider";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { expectAllNoop, makeRenderTest } from "./common.ts";

const t = makeRenderTest();

describe("Render.StaticSite", { tags: ["provider:render", "live"], timeout: 180_000 }, () => {
  t.test.provider(
    "creates, plans noop, looks up, lists, updates headers/routes/envVars, and destroys a StaticSite",
    (stack) =>
      Effect.gen(function* () {
        yield* stack.destroy();

        const prov = yield* Provider.findProvider(Render.StaticSite);
        const program = (version: "v1" | "v2") =>
          Effect.gen(function* () {
            const proj = yield* Render.Project("SiteProj", {
              environments: {
                staging: { name: "staging", protectedStatus: "unprotected" },
              },
            });
            const site = yield* Render.StaticSite("Site", {
              environmentId: proj.environments.staging.id,
              repo: "https://github.com/render-examples/create-react-app",
              branch: "master",
              buildCommand: "echo ok",
              publishPath: "public",
              autoDeploy: false,
              envVars: { SITE_TAG: version },
              ...(version === "v2"
                ? {
                    headers: [{ path: "/*", name: "X-Alchemy-Test", value: "v2" }],
                    routes: [{ type: "rewrite", source: "/app/*", destination: "/index.html" }],
                  }
                : {}),
            });
            return { proj, site };
          });

        const created = yield* stack.deploy(program("v1"));
        expect(created.site.id).toMatch(/^srv-/);
        expect(Redacted.value(created.site.envVars.SITE_TAG)).toBe("v1");

        yield* expectAllNoop(stack, program("v1"));

        const found = yield* prov.lookup!({ id: created.site.id });
        expect(found?.id).toBe(created.site.id);
        expect((yield* prov.list!()).some((s) => s.id === created.site.id)).toBe(true);

        const updated = yield* stack.deploy(program("v2"));
        expect(updated.site.id).toBe(created.site.id);
        expect(Redacted.value(updated.site.envVars.SITE_TAG)).toBe("v2");
        expect(updated.site.headers.some((h) => h.name === "X-Alchemy-Test")).toBe(true);
        expect(updated.site.routes.some((r) => r.source === "/app/*")).toBe(true);

        yield* stack.destroy();
        expect(yield* prov.lookup!({ id: created.site.id })).toBeUndefined();
      }),
    { tags: ["provider:render", "live"], timeout: 180_000 },
  );
});
