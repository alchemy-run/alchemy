import * as Render from "@alchemy.run/render";
import * as Effect from "effect/Effect";
import * as HttpServerResponse from "effect/http/HttpServerResponse";

/**
 * Effectful Render.WebService fixture (`Platform` form with `main: import.meta.url`).
 */
export default class EffectWebService extends Render.WebService<EffectWebService>()(
  "EffectWebService",
  {
    main: import.meta.url,
    registryImage: process.env.RENDER_TEST_REGISTRY_IMAGE ?? "ghcr.io/example/render-effect-app",
    plan: "free",
    region: "oregon",
    healthCheckPath: "/health",
  },
  Effect.gen(function* () {
    return {
      fetch: Effect.gen(function* () {
        return yield* HttpServerResponse.json({ ok: true, mode: "effect" });
      }),
    };
  }),
) {}
