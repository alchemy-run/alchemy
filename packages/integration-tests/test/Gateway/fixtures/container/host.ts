import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Effect from "effect/Effect";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Schedule from "effect/Schedule";
import { GatewayedContainer } from "./container.ts";

/** Starts the container and asks its program for its answer. */
export class ContainerObject extends Cloudflare.DurableObject<ContainerObject>()(
  "GatewayContainerObject",
  Effect.gen(function* () {
    const container = yield* GatewayedContainer;
    return Effect.gen(function* () {
      // Starting is idempotent. Without internet the container cannot reach
      // its gateway.
      const start = container.start({ enableInternet: true });
      const port = yield* container.getTcpPort(3000);
      return {
        ask: () =>
          Effect.gen(function* () {
            yield* start;
            const response = yield* port
              .fetch(HttpClientRequest.get("http://container/"))
              .pipe(Effect.retry({ schedule: Schedule.spaced("2 seconds"), times: 20 }));
            return { status: response.status, text: yield* response.text };
          }).pipe(Effect.orDie),
      };
    });
  }),
) {}

export default class ContainerHost extends Cloudflare.Worker<ContainerHost>()(
  "GatewayContainerHost",
  { main: import.meta.url },
  Effect.gen(function* () {
    const objects = yield* ContainerObject;
    return {
      fetch: Effect.gen(function* () {
        const answer = yield* objects.getByName("default").ask();
        return HttpServerResponse.text(answer.text, {
          status: answer.status,
          headers: { "content-type": "application/json" },
        });
      }).pipe(Effect.orDie),
    };
  }),
) {}
