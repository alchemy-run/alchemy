import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import { SandboxContainer } from "./SandboxContainer.ts";

/**
 * Durable Object that fronts {@link SandboxContainer} — the only way a
 * Worker reaches a Container. `EchoWorker` proxies `GET /sandbox` here.
 */
export default class SandboxDO extends Cloudflare.DurableObject<SandboxDO>()(
  "SandboxDO",
  Effect.gen(function* () {
    const container = yield* SandboxContainer;

    return Effect.gen(function* () {
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
  }).pipe(
    Effect.provide(
      Cloudflare.Containers.layer(SandboxContainer, { enableInternet: true }),
    ),
  ),
) {}
