import * as Cloudflare from "alchemy-effect/Cloudflare";
import * as Effect from "effect/Effect";
import * as HttpBody from "effect/unstable/http/HttpBody";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import Agent from "./Agent.ts";
import NotifyWorkflow from "./NotifyWorkflow.ts";
import Room from "./Room.ts";

export default class Api extends Cloudflare.Worker<Api>()(
  "Api",
  {
    main: import.meta.filename,
    observability: {
      enabled: true,
    },
    compatibility: {
      flags: ["nodejs_compat"],
    },
    assets: "./assets",
  },
  Effect.gen(function* () {
    const agents = yield* Agent;
    const rooms = yield* Room;
    const notifier = yield* NotifyWorkflow;
    const loader = yield* Cloudflare.DynamicWorker("Loader");

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        console.log("fetch", request.method, request.url);

        if (request.url === "/sandbox/increment") {
          const agent = agents.getByName("sandbox-test");
          const body = yield* agent.increment().pipe(Effect.orDie);
          const room = rooms.getByName("default");
          yield* room.broadcast(`[container] ${body}`).pipe(Effect.orDie);
          return HttpServerResponse.text(body, {
            headers: { "content-type": "application/json" },
          });
        } else if (request.url.startsWith("/sandbox")) {
          const agent = agents.getByName("sandbox-test");
          const body = yield* agent.hello().pipe(Effect.orDie);
          return HttpServerResponse.text(body);
        } else if (request.url.startsWith("/workflow/start/")) {
          const roomId = request.url.split("/workflow/start/")[1];
          if (!roomId) {
            return yield* HttpServerResponse.json(
              { error: "roomId is required" },
              { status: 400 },
            );
          }
          const instance = yield* notifier.create({
            roomId,
            message: "hello from workflow",
          });
          return yield* HttpServerResponse.json({ instanceId: instance.id });
        } else if (request.url.startsWith("/workflow/status/")) {
          const instanceId = request.url.split("/workflow/status/")[1];
          if (!instanceId) {
            return yield* HttpServerResponse.json(
              { error: "instanceId is required" },
              { status: 400 },
            );
          }
          const instance = yield* notifier.get(instanceId);
          const status = yield* instance.status();
          return yield* HttpServerResponse.json(status);
        } else if (request.url.startsWith("/eval")) {
          if (request.method === "POST") {
            const code = yield* request.text;
            const worker = loader.load({
              compatibilityDate: "2026-01-28",
              mainModule: "worker.js",
              modules: {
                "worker.js": `
                  export default {
                    async fetch(request) {
                      try {
                        const result = (0, eval)(${"`${await request.text()}`"});
                        return new Response(String(result), { status: 200 });
                      } catch (e) {
                        return new Response(e.message, { status: 500 });
                      }
                    }
                  }
                `,
              },
              globalOutbound: null,
            });
            return yield* worker
              .fetch(
                HttpClientRequest.post("https://worker/").pipe(
                  HttpClientRequest.setBody(HttpBody.text(code)),
                ),
              )
              .pipe(
                Effect.map(HttpServerResponse.fromClientResponse),
                Effect.orDie,
              );
          }
        } else if (request.url.startsWith("/connect/")) {
          const agentId = request.url.split("/").pop()!;
          const agent = agents.getByName(agentId);
          const response = yield* agent.fetch(request);
          return response;
        } else if (request.url.startsWith("/room/")) {
          console.log("request.url", request.url);
          const upgradeHeader = request.headers.upgrade;
          const roomId = request.url.split("/").pop()!;
          if (!upgradeHeader || upgradeHeader !== "websocket") {
            return HttpServerResponse.text(
              "Worker expected Upgrade: websocket",
              { status: 426 },
            );
          } else if (request.method !== "GET") {
            return HttpServerResponse.text("Method not allowed", {
              status: 405,
            });
          }
          const room = rooms.getByName(roomId);
          console.log("room", roomId);
          const response = yield* room.fetch(request);
          return response;
        }
        return HttpServerResponse.text("Hello World", { status: 200 });
      }),
    };
  }),
) {}
