import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import { OtelRpcHost, OtelRpcObject } from "./host.ts";
import { RpcTelemetry } from "./telemetry.ts";

/**
 * Calls a Durable Object hosted by another script (`.from(OtelRpcHost)`) and
 * that script's RPC method (`bindWorker(OtelRpcHost)`), each inside a span of
 * its own, so the test can check the callee's span is its child.
 */
export default class OtelRpcCaller extends Cloudflare.Worker<OtelRpcCaller>()(
  "OtelRpcCaller",
  { main: import.meta.url },
  Effect.gen(function* () {
    const objects = yield* OtelRpcObject.from(OtelRpcHost);
    const host = yield* Cloudflare.Workers.bindWorker(OtelRpcHost);
    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        if (request.url.includes("/object")) {
          const pong = yield* objects
            .getByName("a")
            .ping()
            .pipe(Effect.withSpan("otel-rpc.caller.object"));
          return HttpServerResponse.text(`caller-saw:${pong}`);
        }
        const greeting = yield* host.greet("rpc").pipe(Effect.withSpan("otel-rpc.caller.service"));
        return HttpServerResponse.text(`caller-saw:${greeting}`);
      }).pipe(Effect.orDie),
    };
  }).pipe(Effect.provide(RpcTelemetry)),
) {}
