import * as Railway from "alchemy/Railway";
import * as Effect from "effect/Effect";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";
import * as Etag from "effect/http/Etag";
import * as HttpPlatform from "effect/http/HttpPlatform";
import * as HttpRouter from "effect/http/HttpRouter";
import * as Layer from "effect/Layer";
import { Site } from "./shared.ts";
import { GreetingApi } from "./spec.ts";

/** A basic Effect HTTP API on a Railway Service, called by the solid-yield SPA. */
export default class Api extends Railway.Service<Api>()(
  "Api",
  {
    project: Site,
    main: import.meta.url,
    port: 3000,
    healthcheck: "/api/greeting",
  },
  Effect.gen(function* () {
    const greeting = HttpApiBuilder.group(GreetingApi, "Greeting", (handlers) =>
      handlers.handle("greeting", () =>
        Effect.succeed({ message: "Hello from the Railway API!", platform: "Railway" }),
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
