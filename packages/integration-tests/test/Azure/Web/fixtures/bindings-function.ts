import * as Azure from "@alchemy.run/azure";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Layer from "effect/Layer";
import { distilledFromSource } from "../../Functions/fixtures/distilled-source.ts";

/**
 * Web app the bindings start, stop, and restart. Module-scope so the test
 * stack yields the same declaration. A free (F1) Linux plan in westus3,
 * where the trial subscription has F1 quota; no code is deployed.
 */
export const Site = Effect.gen(function* () {
  const plan = yield* Azure.Web.AppServicePlan("WebBindingsPlan", {
    location: "westus3",
    sku: "F1",
    os: "linux",
  });
  return yield* Azure.Web.WebApp("WebBindingsSite", {
    location: "westus3",
    serverFarmId: plan.appServicePlanId,
    os: "linux",
  });
});

/** Answer `{ ok, result }`, or `{ ok: false, error }` with a 500 so callers retry. */
const respond = (effect: Effect.Effect<unknown, unknown, RuntimeContext>) =>
  effect.pipe(
    Effect.flatMap((result) => HttpServerResponse.json({ ok: true, result })),
    Effect.catchCause((cause) =>
      HttpServerResponse.json({ ok: false, error: Cause.pretty(cause) }, { status: 500 }),
    ),
  );

/**
 * Effect-native Azure Function exercising the App Service runtime-action
 * bindings on a managed-identity host, one route per binding.
 */
export default class WebBindingsFunction extends Azure.Functions.Function<WebBindingsFunction>()(
  "WebBindingsFunction",
  {
    main: import.meta.url,
    // TEMPORARY: this checkout's distilled `lib/` is stale (see distilled-source.ts).
    build: { input: { plugins: [distilledFromSource] } },
  },
  Effect.gen(function* () {
    const site = yield* Site;
    const start = yield* Azure.Web.StartWebApp(site);
    const stop = yield* Azure.Web.StopWebApp(site);
    const restart = yield* Azure.Web.RestartWebApp(site);

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.url, "http://localhost");
        switch (url.pathname) {
          case "/start":
            return yield* respond(start());
          case "/stop":
            return yield* respond(stop());
          case "/restart":
            return yield* respond(restart({ synchronous: true }));
          default:
            return HttpServerResponse.text("ok");
        }
      }),
    };
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        Azure.Web.StartWebAppHttp,
        Azure.Web.StopWebAppHttp,
        Azure.Web.RestartWebAppHttp,
      ),
    ),
  ),
) {}
