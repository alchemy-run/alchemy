import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Effect from "effect/Effect";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import { EchoGateway, EGRESS_HOST } from "./gateway.ts";

export { EGRESS_HOST } from "./gateway.ts";

/** `ctx.exports` entrypoints; workers-types does not type them on DurableObjectState. */
interface InterceptExports {
  default(options: { props: Record<string, unknown> }): import("@cloudflare/workers-types").Fetcher;
}

/** Only the owning object's `interceptOutboundHttp` answers this host. */
export const INTERCEPT_HOST = "intercept.internal";

class InterceptContainer extends Cloudflare.Container<InterceptContainer>()("InterceptContainer", {
  // Template string, not `path.join(import.meta.dirname, …)`: this module is
  // bundled into the Worker and `import.meta.dirname` is undefined there.
  context: `${import.meta.dirname}/context`,
}) {}

/**
 * Durable Object that owns an {@link InterceptContainer} through
 * `yield* InterceptContainer` and routes the container's outbound HTTP back to itself:
 * the Fetcher it registers is a stub for its own id, so intercepted requests
 * arrive at its `fetch`.
 */
export class InterceptContainerObject extends Cloudflare.DurableObject<InterceptContainerObject>()(
  "InterceptContainerObject",
  Effect.gen(function* () {
    const container = yield* InterceptContainer;
    const state = yield* Cloudflare.DurableObjectState;
    // Answers the container's requests to EGRESS_HOST (through its gateway), showing what arrived.
    const { echo } = yield* EchoGateway;
    const env = yield* Cloudflare.WorkerEnvironment;

    return Effect.gen(function* () {
      const self = Cloudflare.fromCloudflareFetcher(env.InterceptContainerObject.get(state.id));
      // Starting is idempotent: a no-op once the container is running.
      const start = container.start({ enableInternet: false });
      const { fetch } = yield* container.getTcpPort(8080);

      const probe = (url: string) =>
        Effect.gen(function* () {
          const response = yield* fetch(
            HttpClientRequest.get(`http://container/probe?url=${encodeURIComponent(url)}`),
          );
          return yield* response.text;
        });

      const probeTls = (url: string) =>
        Effect.gen(function* () {
          const response = yield* fetch(
            HttpClientRequest.get(`http://container/probe-tls?url=${encodeURIComponent(url)}`),
          );
          return yield* response.text;
        });
      const ca = Effect.gen(function* () {
        const response = yield* fetch(HttpClientRequest.get("http://container/ca"));
        return yield* response.text;
      });
      // Cloudflare delivers intercepted traffic only to a Worker entrypoint or
      // service binding: this Worker's default entrypoint, tagged by props.
      const entrypoint = Cloudflare.fromCloudflareFetcher(
        (state.raw as unknown as { exports: InterceptExports }).exports.default({
          props: { intercepted: true },
        }),
      );

      const probeJson = (path: string) =>
        Effect.gen(function* () {
          const response = yield* fetch(HttpClientRequest.get(`http://container${path}`));
          return yield* response.text;
        });

      return {
        // An egress answers its host over HTTPS (HTTP isn't routed); other hosts are unreachable.
        probeEgress: () =>
          container.start({ egress: [echo] }).pipe(
            Effect.andThen(
              Effect.all({
                http: probe(`http://${EGRESS_HOST}/hello`),
                https: probeTls(`https://${EGRESS_HOST}/hello`),
                other: probe("http://not-allowed.example/hello"),
              }),
            ),
            Effect.flatMap((result) =>
              // Removing it refuses its host on the running container.
              container.setEgress({ egress: [] }).pipe(
                Effect.andThen(probeTls(`https://${EGRESS_HOST}/again`)),
                Effect.map((removed) => JSON.stringify({ ...result, removed })),
              ),
            ),
          ),
        // HTTP through the Worker entrypoint (the production-compatible route).
        probeEntrypoint: () =>
          start.pipe(
            Effect.andThen(container.interceptOutboundHttp(INTERCEPT_HOST, entrypoint)),
            Effect.andThen(probe(`http://${INTERCEPT_HOST}/hello`)),
          ),
        // HTTPS: the CA must appear in the container, and the TLS request must
        // reach the entrypoint.
        probeHttps: () =>
          start.pipe(
            Effect.andThen(container.interceptOutboundHttps(INTERCEPT_HOST, entrypoint)),
            Effect.andThen(
              Effect.all({ ca, response: probeTls(`https://${INTERCEPT_HOST}/hello`) }),
            ),
            Effect.map(({ ca, response }) =>
              JSON.stringify({ ca: JSON.parse(ca), ...JSON.parse(response) }),
            ),
          ),
        // The container's intercepted requests.
        fetch: Effect.gen(function* () {
          const request = yield* HttpServerRequest;
          return HttpServerResponse.text(`intercepted ${request.headers.host}${request.url}`);
        }),
        probeHost: () =>
          start.pipe(
            Effect.andThen(container.interceptOutboundHttp(INTERCEPT_HOST, self)),
            Effect.andThen(probe(`http://${INTERCEPT_HOST}/hello`)),
          ),
        probeAll: () =>
          start.pipe(
            Effect.andThen(container.interceptAllOutboundHttp(self)),
            Effect.andThen(probe("http://any.example/hello")),
          ),
      };
    });
  }),
) {}
