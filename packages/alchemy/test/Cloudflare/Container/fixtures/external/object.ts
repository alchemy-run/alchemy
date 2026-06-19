import * as Cloudflare from "@/Cloudflare";
import * as Effect from "effect/Effect";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import { ExternalContainer } from "./container.ts";

/**
 * Durable Object that binds and starts the {@link ExternalContainer} and
 * proxies an HTTP request to the nginx server running on port 8080 inside it.
 */
export class ExternalContainerObject extends Cloudflare.DurableObjectNamespace<ExternalContainerObject>()(
  "ExternalContainerObject",
  Effect.gen(function* () {
    const bound = yield* Cloudflare.Container.bind(ExternalContainer);

    return Effect.gen(function* () {
      const container = yield* Cloudflare.start(bound);

      return {
        hello: () =>
          Effect.gen(function* () {
            const { fetch } = yield* container.getTcpPort(8080);
            const response = yield* fetch(
              HttpClientRequest.get("http://container/"),
            );
            return yield* response.text;
          }),
      };
    });
  }),
) {}
