/// <reference types="@effect/ui/html/HtmlServerViteDocument" />
import { layerHttp } from "@effect/ui/html/HtmlServerHttp";
import { Effect, Layer } from "effect";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import { document } from "virtual:@effect/ui/document";
import { App } from "./App.ts";
import { AppRoute } from "./routes.ts";

export { prerender } from "./prerender.ts";

// Names the runtime that answered (`Cloudflare-Workers`, `Node.js/…`), so a
// test can tell where pages render.
const Runtime = HttpRouter.add(
  "GET",
  "/__runtime",
  Effect.sync(() => HttpServerResponse.text(globalThis.navigator?.userAgent ?? "unknown")),
);

export default Layer.mergeAll(
  Runtime,
  layerHttp(App, { routes: AppRoute, document, base: import.meta.env.BASE_URL }),
);
