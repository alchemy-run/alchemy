import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";
import * as Etag from "effect/http/Etag";
import * as HttpPlatform from "effect/http/HttpPlatform";
import * as HttpRouter from "effect/http/HttpRouter";
import * as Layer from "effect/Layer";
import { GreetingApi } from "./spec.ts";

/** The Effect API Worker: implements the shared `GreetingApi` spec. */
export default class Api extends Cloudflare.Worker<Api>()(
  "Api",
  { main: import.meta.url },
  Effect.gen(function* () {
    const greeting = HttpApiBuilder.group(GreetingApi, "Greeting", (handlers) =>
      handlers.handle("greeting", () =>
        Effect.sync(() => ({
          message: "Hello from the Cloudflare API!",
          platform: "Cloudflare",
          servedAt:
            new Date().toLocaleTimeString("en-US", { timeZone: "UTC", hour12: false }) + " UTC",
        })),
      ),
    );

    return {
      fetch: HttpApiBuilder.layer(GreetingApi).pipe(
        Layer.provide(greeting),
        // The SPA is served from another origin.
        Layer.provide(HttpRouter.cors()),
        Layer.provide([HttpPlatform.layer, Etag.layer]),
        HttpRouter.toHttpEffect,
      ),
    };
  }),
) {}
