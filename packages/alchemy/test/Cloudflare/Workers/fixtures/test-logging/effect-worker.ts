import * as Cloudflare from "@/Cloudflare";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

/**
 * Effect-native worker fixture for the test-logging pipeline. Logs via the
 * global `console` (patched by the runtime bundled through `WorkerBridge`)
 * and echoes the `alchemy-request-id` header back so the test can learn its
 * own request ID.
 *
 * GET /?marker=<m> → console.log + console.warn tagged with <m>, returns
 * `{ requestId }`.
 */
export default class TestLogEffectWorker extends Cloudflare.Worker<TestLogEffectWorker>()(
  "TestLogEffectWorker",
  {
    main: import.meta.url,
  },
  Effect.gen(function* () {
    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.url, "http://x");
        const marker = url.searchParams.get("marker") ?? "none";
        yield* Effect.sync(() => {
          console.log(`effect-log ${marker}`);
          console.warn(`effect-warn ${marker}`);
        });
        return yield* HttpServerResponse.json({
          requestId: request.headers["alchemy-request-id"] ?? null,
        });
      }),
    };
  }),
) {}
