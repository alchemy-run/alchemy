import * as Cloudflare from "@/Cloudflare";
import * as Effect from "effect/Effect";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";

/** A real HTTP server that accepts connections but never responds. */
export class TimeoutContainer extends Cloudflare.Container<TimeoutContainer>()(
  "TimeoutContainer",
  {
    image: "oven/bun:latest",
    observability: { logs: { enabled: true } },
  },
) {}

/**
 * Durable Object that binds and starts the {@link TimeoutContainer} and
 * proxies an HTTP request to the echo server running on port 8080 inside it.
 */
export class TimeoutContainerObject extends Cloudflare.DurableObject<TimeoutContainerObject>()(
  "TimeoutContainerObject",
  Effect.gen(function* () {
    const container = yield* TimeoutContainer;

    return Effect.gen(function* () {
      const { fetch } = yield* container.getTcpPort(8080);

      return {
        hello: () =>
          Effect.gen(function* () {
            const response = yield* fetch(
              HttpClientRequest.get("http://container/"),
            );
            return yield* response.text;
          }),
      };
    });
  }).pipe(
    Effect.provide(
      Cloudflare.Containers.layer(TimeoutContainer, {
        enableInternet: false,
        entrypoint: [
          "bun",
          "-e",
          "Bun.serve({port:8080,fetch(){return new Promise(()=>{})}})",
        ],
      }),
    ),
  ),
) {}
