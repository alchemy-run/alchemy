import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Effect from "effect/Effect";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import { RpcTelemetry } from "./telemetry.ts";

/** A Durable Object class another script reaches with `.from(OtelRpcHost)`. */
export class OtelRpcObject extends Cloudflare.DurableObject<
  OtelRpcObject,
  { ping: () => Effect.Effect<string> }
>()("OtelRpcObject") {}

/** An Effect Worker that hosts {@link OtelRpcObject} and serves `greet` over RPC. */
export class OtelRpcHost extends Cloudflare.Worker<
  OtelRpcHost,
  { greet: (name: string) => Effect.Effect<string> },
  OtelRpcObject
>()("OtelRpcHost") {}

export default OtelRpcHost.make(
  { main: import.meta.url },
  Effect.gen(function* () {
    yield* OtelRpcObject;
    return {
      greet: (name: string) =>
        Effect.succeed(`hello ${name}`).pipe(Effect.withSpan("otel-rpc.host.greet")),
      fetch: Effect.succeed(HttpServerResponse.text("otel rpc host")),
    };
  }).pipe(
    Effect.provide(
      OtelRpcObject.make(
        Effect.succeed(
          Effect.succeed({
            ping: () => Effect.succeed("pong").pipe(Effect.withSpan("otel-rpc.object.ping")),
          }),
        ),
      ),
    ),
    Effect.provide(RpcTelemetry),
  ),
);
