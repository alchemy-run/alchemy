import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import { HttpClientRequest, HttpServerResponse } from "effect/unstable/http";
import { SandboxContainer } from "./SandboxContainer.ts";

export default class SandboxDO extends Cloudflare.DurableObjectNamespace<SandboxDO>()(
  "SandboxDO",
  Effect.gen(function* () {
    const sandbox = yield* Cloudflare.Container.bind(SandboxContainer);

    return Effect.gen(function* () {
      const container = yield* Cloudflare.start(sandbox, {
        enableInternet: true,
      });

      return {
        fetch: Effect.gen(function* () {
          const { fetch } = yield* container.getTcpPort(3000);
          const response = yield* fetch(
            HttpClientRequest.get("http://container/"),
          );
          return HttpServerResponse.text(yield* response.text, {
            status: response.status,
            headers: response.headers,
          });
        }),
      };
    });
  }),
) {}
