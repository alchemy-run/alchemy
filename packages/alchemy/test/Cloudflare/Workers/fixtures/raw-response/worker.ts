import * as Cloudflare from "@/Cloudflare/index.ts";
import * as Effect from "effect/Effect";
import * as EffectHttp from "effect/unstable/http/HttpEffect";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

export default class RawResponseWorker extends Cloudflare.Worker<RawResponseWorker>()(
  "RawResponseWorker",
  { main: import.meta.url },
  Effect.succeed({
    fetch: Effect.gen(function* () {
      const request = yield* HttpServerRequest;
      const path = yield* Effect.sync(
        () => new URL(request.url, "https://worker.test").pathname,
      );
      if (path === "/ready")
        return HttpServerResponse.text("raw-response:ready");

      if (path === "/status" || path === "/stream") {
        yield* EffectHttp.appendPreResponseHandler((_, response) =>
          Effect.succeed(
            response.pipe(
              HttpServerResponse.setHeader(
                "x-observed-status",
                String(response.status),
              ),
              HttpServerResponse.setHeader(
                "x-observed-native",
                response.headers["x-native"] ?? "missing",
              ),
              HttpServerResponse.setStatus(418),
              HttpServerResponse.setHeader("x-native", "effect"),
              HttpServerResponse.removeHeader("x-remove"),
            ),
          ),
        );
      } else if (path === "/cookie") {
        yield* EffectHttp.appendPreResponseHandler((_, response) =>
          Effect.succeed(
            HttpServerResponse.setCookieUnsafe(response, "session", "abc", {
              path: "/",
            }),
          ),
        );
      } else if (path === "/no-content") {
        yield* EffectHttp.appendPreResponseHandler((_, response) =>
          Effect.succeed(HttpServerResponse.setStatus(response, 204)),
        );
      }

      const native = yield* Effect.sync(() => {
        const body =
          path === "/stream"
            ? new ReadableStream<Uint8Array>({
                start(controller) {
                  controller.enqueue(
                    new TextEncoder().encode("raw-response:streamed"),
                  );
                  controller.close();
                },
              })
            : "raw-response:body";
        return new Response(body, {
          status: 202,
          headers: [
            ["x-native", "native"],
            ["x-remove", "native"],
            ["set-cookie", "a=1; Path=/"],
            ["set-cookie", "b=2; Path=/"],
          ],
        });
      });
      return HttpServerResponse.raw(
        native,
        path === "/constructed-header"
          ? { headers: { "x-native": "constructed" } }
          : undefined,
      );
    }),
  }),
) {}
