import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import { workerOptions } from "./options.ts";
import { WebSocketObject } from "./websocket-object.ts";

export default Cloudflare.Worker(
  "DeepWebSocketWorker",
  { ...workerOptions, main: import.meta.url },
  Effect.gen(function* () {
    const objects = yield* WebSocketObject;
    const version = yield* Cloudflare.Workers.VersionMetadata();
    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const path = new URL(request.url, "https://websocket.invalid").pathname;
        if (request.method !== "GET")
          return HttpServerResponse.text("GET required", { status: 405 });
        if (path === "/health")
          return yield* HttpServerResponse.json(
            {
              ok: true,
              harness: "cloudflare-websocket-v1",
              version: yield* version,
              protocol: "Effect RPC framed JSON over one hibernating WebSocket",
            },
            { headers: { "cache-control": "no-store" } },
          );
        const actor = /^\/rpc\/([a-zA-Z0-9_-]{1,100})$/.exec(path)?.[1];
        if (!actor) return HttpServerResponse.text("Not found", { status: 404 });
        return yield* objects.fetch(actor, request);
      }).pipe(Effect.scoped, Effect.orDie),
    };
  }).pipe(Effect.provide(Cloudflare.Workers.VersionMetadataBinding)),
);
