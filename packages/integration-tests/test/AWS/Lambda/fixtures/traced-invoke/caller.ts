import * as Lambda from "@alchemy.run/aws/Lambda";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { CollectorTelemetry } from "../../../../Utils/Telemetry.ts";
import TracedInvokeCalleeLive, { TracedInvokeCallee } from "./callee.ts";

export class TracedInvokeCaller extends Lambda.Function<Lambda.Function>()("TracedInvokeCaller") {}

/**
 * A function URL whose `GET /rpc-traced?tag=…` invokes {@link TracedInvokeCallee}
 * synchronously through `Lambda.InvokeFunction`, inside `rpc-caller:<tag>`.
 */
export default TracedInvokeCaller.make(
  { main: import.meta.url, functionUrl: true },
  Effect.gen(function* () {
    const callee = yield* TracedInvokeCallee.pipe(Effect.provide(TracedInvokeCalleeLive));
    const invoke = yield* Lambda.InvokeFunction(callee);
    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.originalUrl);
        const tag = url.searchParams.get("tag") ?? "none";
        const response = yield* invoke({
          Payload: new TextEncoder().encode(JSON.stringify({ traced: tag })),
        }).pipe(Effect.withSpan(`rpc-caller:${tag}`));
        const body = response.Payload
          ? yield* response.Payload.pipe(Stream.decodeText(), Stream.mkString)
          : "{}";
        return HttpServerResponse.text(`traced ${(JSON.parse(body) as { traced: string }).traced}`);
      }).pipe(Effect.orDie),
    };
  }).pipe(
    Effect.provide(
      Layer.mergeAll(Lambda.InvokeFunctionHttp, CollectorTelemetry("lambda-invoke-caller")),
    ),
  ),
);
