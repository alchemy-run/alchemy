/// <reference types="@effect/ui/html/HtmlServerViteDocument" />
import { layerHttp } from "@effect/ui/html/HtmlServerHttp";
import { Effect, Layer } from "effect";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import { document } from "virtual:@effect/ui/document";
import { App } from "./App.ts";
import { AppRoute } from "./routes.ts";

export { prerender } from "./prerender.ts";

// The build imports this module in Node to prerender, where
// `cloudflare:workers` doesn't exist: import it when a request arrives.
const Greeting = HttpRouter.add(
  "GET",
  "/__greeting",
  Effect.promise(() => import("cloudflare:workers")).pipe(
    Effect.map(({ env }) => HttpServerResponse.text(String(Reflect.get(env, "GREETING")))),
  ),
);

export default Layer.mergeAll(
  Greeting,
  layerHttp(App, { routes: AppRoute, document, base: import.meta.env.BASE_URL }),
);
