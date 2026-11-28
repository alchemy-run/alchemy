import * as Render from "@alchemy.run/render";
import { describe, expect } from "@alchemy.run/test";
import * as Provider from "alchemy/Provider";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
import { expectAllNoop, makeRenderTest } from "./common.ts";

const t = makeRenderTest();
import { AsyncWebService } from "./fixtures/async-app.ts";
import EffectWebService from "./fixtures/effect-app.ts";

const registryImage = process.env.RENDER_TEST_REGISTRY_IMAGE;

describe("Render.WebService", { tags: ["provider:render", "live"], timeout: 240_000 }, () => {
  t.test.provider(
    "creates with live HTTP check, plans noop, looks up, lists, updates, suspends/resumes, purges cache, reads logs, and destroys",
    (stack) =>
      Effect.gen(function* () {
        yield* stack.destroy();

        const prov = yield* Provider.findProvider(Render.WebService);
        const program = (version: "v1" | "v2", options?: { readonly suspended?: boolean }) =>
          Effect.gen(function* () {
            const proj = yield* Render.Project("WebProj", {
              environments: {
                staging: { name: "staging", protectedStatus: "unprotected" },
              },
            });
            const web = yield* Render.WebService("Web", {
              plan: "free",
              region: "oregon",
              environmentId: proj.environments.staging.id,
              envVars: { SERVICE_TAG: version },
              ...(options?.suspended !== undefined ? { suspended: options.suspended } : {}),
              waitForDeployCompletion: version === "v1",
              skipDeployAfterUpdate: version !== "v1",
              runtimeSource: {
                image: {
                  imagePath: "docker.io/nginxdemos/hello",
                  tag: "plain-text",
                },
              },
            });
            return { proj, web };
          });

        const created = yield* stack.deploy(program("v1"));
        expect(created.web.id).toMatch(/^srv-/);
        expect(created.web.url).toMatch(/^https:\/\/.+\.onrender\.com$/);
        expect(Redacted.value(created.web.envVars.SERVICE_TAG)).toBe("v1");

        // Verify the live WebService URL actually answers HTTP 200
        const http = yield* HttpClient.HttpClient;
        const response = yield* http.get(created.web.url!).pipe(
          Effect.flatMap((res) =>
            res.status === 200 ? Effect.succeed(res) : Effect.fail(new Error(`HTTP ${res.status}`)),
          ),
          Effect.retry({ schedule: Schedule.spaced("3 seconds"), times: 10 }),
        );
        expect(response.status).toBe(200);

        yield* expectAllNoop(stack, program("v1"));

        const found = yield* prov.lookup!({ id: created.web.id });
        expect(found?.id).toBe(created.web.id);
        expect((yield* prov.list!()).some((s) => s.id === created.web.id)).toBe(true);

        const updated = yield* stack.deploy(program("v2"));
        expect(updated.web.id).toBe(created.web.id);
        expect(Redacted.value(updated.web.envVars.SERVICE_TAG)).toBe("v2");

        const paused = yield* stack.deploy(program("v2", { suspended: true }));
        expect(paused.web.suspended).toBe("suspended");

        const resumed = yield* stack.deploy(program("v2", { suspended: false }));
        expect(resumed.web.suspended).toBe("not_suspended");

        const purgeResult = yield* Render.purgeServiceCache(resumed.web.id).pipe(
          Effect.map(() => "ok" as const),
          Effect.catchTag("BadRequest", () => Effect.succeed("caching-disabled" as const)),
        );
        expect(["ok", "caching-disabled"]).toContain(purgeResult);
        const logs = yield* prov.logs!({
          id: "Web",
          fqn: "Web",
          instanceId: resumed.web.id,
          props: {
            runtimeSource: {
              image: { imagePath: "docker.io/nginxdemos/hello", tag: "plain-text" },
            },
          },
          output: resumed.web,
          options: { since: new Date(Date.now() - 10 * 60 * 1000), limit: 20 },
        });
        expect(Array.isArray(logs)).toBe(true);

        yield* stack.destroy();
        expect(yield* prov.lookup!({ id: created.web.id })).toBeUndefined();
      }),
    { tags: ["provider:render", "live"], timeout: 240_000 },
  );

  t.test.provider.skipIf(!registryImage)(
    "deploys Effect (Platform) and Async (InferEnv) WebService handlers and verifies live JSON over HTTPS",
    (stack) =>
      Effect.gen(function* () {
        yield* stack.destroy();
        const deployed = yield* stack.deploy(
          Effect.gen(function* () {
            const fx = yield* EffectWebService;
            const asyncSvc = yield* AsyncWebService;
            return { fx, asyncSvc };
          }),
        );
        const http = yield* HttpClient.HttpClient;
        const fxJson = yield* http.get(`${deployed.fx.url}/`).pipe(
          Effect.flatMap((res) => res.json),
          Effect.retry({ schedule: Schedule.spaced("5 seconds"), times: 12 }),
        );
        const asyncJson = yield* http.get(`${deployed.asyncSvc.url}/`).pipe(
          Effect.flatMap((res) => res.json),
          Effect.retry({ schedule: Schedule.spaced("5 seconds"), times: 12 }),
        );
        expect(fxJson).toEqual({ ok: true, mode: "effect" });
        expect(asyncJson).toEqual({ ok: true, mode: "async", greeting: "hello-render" });
        yield* stack.destroy();
      }),
    { tags: ["provider:render", "live"], timeout: 240_000 },
  );
});
