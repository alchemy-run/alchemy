import * as Hetzner from "alchemy/Hetzner";
import * as Effect from "effect/Effect";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";
import * as Etag from "effect/http/Etag";
import * as HttpPlatform from "effect/http/HttpPlatform";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Layer from "effect/Layer";
import { API_PORT, Box } from "./shared.ts";
import { GreetingApi } from "./spec.ts";

const greeting = HttpApiBuilder.group(GreetingApi, "Greeting", (handlers) =>
  handlers.handle("greeting", () =>
    Effect.sync(() => ({
      message: "Hello from the Hetzner API!",
      platform: "Hetzner",
      servedAt: new Date().toLocaleTimeString("en-US", { timeZone: "UTC", hour12: false }) + " UTC",
    })),
  ),
);

/** A basic Effect HTTP API on the shared Hetzner Server, called by the solid-yield SPA. */
export default class Api extends Hetzner.Service<Api>()(
  "Api",
  Effect.gen(function* () {
    const server = yield* Box;
    return {
      server,
      main: import.meta.url,
      port: API_PORT,
    };
  }),
  Effect.succeed({
    fetch: HttpApiBuilder.layer(GreetingApi).pipe(
      Layer.provide(greeting),
      // The Hetzner Service deploy waits on a `GET /health` probe.
      Layer.provide(HttpRouter.add("GET", "/health", HttpServerResponse.text("ok"))),
      // The SPA is served from another origin.
      Layer.provide(HttpRouter.cors()),
      Layer.provide([HttpPlatform.layer, Etag.layer]),
      HttpRouter.toHttpEffect,
    ),
  }),
) {}
