import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

/**
 * Effect-native Cloudflare Container. Under `alchemy dev` the local
 * provider builds/pulls the image and runs it in Docker; `SandboxDO`
 * fronts it and `EchoWorker` proxies `GET /sandbox` into it.
 *
 * It exists in this stack so the stress suite covers a local resource
 * whose restart is EXPENSIVE: the point of the container assertions is
 * that unrelated churn (worker-source edits, stack reloads, broken
 * intermediate states) must NOT bounce the container.
 */
export class SandboxContainer extends Cloudflare.Container<
  SandboxContainer,
  {}
>()("SandboxContainer") {}

export const SandboxLive = /* @__PURE__ */ SandboxContainer.make(
  {
    main: import.meta.url,
    image: "oven/bun:latest",
    env: { SANDBOX_GREETING: "hello-from-container" },
  },
  Effect.gen(function* () {
    return SandboxContainer.of({
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.url, "http://container");
        return yield* HttpServerResponse.json({
          greeting: process.env.SANDBOX_GREETING ?? null,
          path: url.pathname,
        });
      }),
    });
  }),
);

export default SandboxLive;
