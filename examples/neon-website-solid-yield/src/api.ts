import * as Neon from "alchemy/Neon";
import * as Effect from "effect/Effect";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";
import * as Etag from "effect/http/Etag";
import * as HttpPlatform from "effect/http/HttpPlatform";
import * as HttpRouter from "effect/http/HttpRouter";
import * as Layer from "effect/Layer";
import { Project } from "./project.ts";
import { GreetingApi } from "./spec.ts";

/** A basic Effect HTTP API on a Neon Function, called by the solid-yield SPA. */
export default class Api extends Neon.Function<Api>()(
  "Api",
  Effect.gen(function* () {
    return { project: yield* Project, main: import.meta.url };
  }),
  Effect.gen(function* () {
    const greeting = HttpApiBuilder.group(GreetingApi, "Greeting", (handlers) =>
      handlers.handle("greeting", () =>
        Effect.succeed({ message: "Hello from the Neon API!", platform: "Neon" }),
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
