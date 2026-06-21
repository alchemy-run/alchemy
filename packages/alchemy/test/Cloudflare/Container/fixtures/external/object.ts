import * as Cloudflare from "@/Cloudflare";
import * as Effect from "effect/Effect";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import path from "node:path";

class ExternalContainer extends Cloudflare.Container<ExternalContainer>()(
  "ExternalContainer",
  {
    context: path.join(import.meta.dirname, "context"),
    observability: { logs: { enabled: true } },
  },
) {}

/**
 * Durable Object that binds and starts the {@link ExternalContainer} and
 * proxies an HTTP request to the nginx server running on port 8080 inside it.
 */
export class ExternalContainerObject extends Cloudflare.DurableObjectNamespace<ExternalContainerObject>()(
  "ExternalContainerObject",
  Effect.gen(function* () {
    const container = yield* ExternalContainer;

    return Effect.gen(function* () {
      const instance = yield* Cloudflare.start(container);

      return {
        hello: () =>
          Effect.gen(function* () {
            const { fetch } = yield* instance.getTcpPort(8080);
            const response = yield* fetch(
              HttpClientRequest.get("http://container/"),
            );
            return yield* response.text;
          }),
      };
    });
  }),
) {}
