import * as GCP from "alchemy/GCP";
import * as Effect from "effect/Effect";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";
import * as Etag from "effect/http/Etag";
import * as HttpPlatform from "effect/http/HttpPlatform";
import * as HttpRouter from "effect/http/HttpRouter";
import * as Layer from "effect/Layer";
import { GreetingApi } from "./spec.ts";

/**
 * A basic Effect HTTP API on Cloud Run, called by the solid-yield SPA.
 *
 * `invokerIamDisabled: true` makes the service publicly reachable so the
 * browser can call it without a Google identity token.
 */
export default class Api extends GCP.Function<Api>()(
  "Api",
  {
    main: import.meta.url,
    invokerIamDisabled: true,
  },
  Effect.gen(function* () {
    const greeting = HttpApiBuilder.group(GreetingApi, "Greeting", (handlers) =>
      handlers.handle("greeting", () =>
        Effect.sync(() => ({
          message: "Hello from the GCP API!",
          platform: "GCP",
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
