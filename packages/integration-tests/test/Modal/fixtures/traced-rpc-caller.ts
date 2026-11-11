import * as Modal from "@alchemy.run/modal";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Layer from "effect/Layer";
import { callTraced, CollectorTelemetry } from "../../Utils/Telemetry.ts";
import { TracedRpcApp } from "./traced-rpc-app.ts";
import TracedRpcFunction from "./traced-rpc-function.ts";
import TracedRpcServer from "./traced-rpc-server.ts";

/**
 * A public Server that calls {@link TracedRpcServer} and {@link TracedRpcFunction}
 * over their bindings, each call inside a span of its own:
 * `GET /server?tag=…` and `GET /function?tag=…`.
 */
export default class TracedRpcCaller extends Modal.Server<TracedRpcCaller>()(
  "TracedRpcCaller",
  { main: import.meta.url, app: TracedRpcApp, unauthenticated: true },
  Effect.gen(function* () {
    const server = yield* Modal.FetchServer(TracedRpcServer);
    const fn = yield* Modal.InvokeFunction(TracedRpcFunction);
    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.url, "http://caller");
        const tag = url.searchParams.get("tag") ?? "none";
        if (url.pathname === "/server") {
          return HttpServerResponse.text(yield* callTraced(server, tag));
        }
        if (url.pathname === "/function") {
          return HttpServerResponse.text(yield* callTraced(fn, tag));
        }
        return HttpServerResponse.text("traced rpc caller ok");
      }).pipe(Effect.orDie),
    };
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        Modal.FetchServerHttp,
        Modal.InvokeFunctionHttp,
        CollectorTelemetry("modal-rpc-caller"),
      ),
    ),
  ),
) {}
