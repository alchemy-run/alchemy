import * as Cloudflare from "alchemy-effect/Cloudflare";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import Agent from "./Agent.ts";
import Room from "./Room.ts";

// declare the Api service with a tag + props
export default class Api extends Cloudflare.Worker<Api>()(
  "Api",
  {
    main: import.meta.path,
    observability: {
      enabled: true,
    },
    compatibility: {
      flags: ["nodejs_compat"],
    },
    assets: "./assets",
  },
  Effect.gen(function* () {
    // (Infrastructure dependencies are bound here)

    // bind the Agent DO to the Worker
    const agents = yield* Agent;
    const rooms = yield* Room;

    return {
      fetch: Effect.gen(function* () {
        // (Business logic is implemented here and can reference bound infrastructure above)
        const request = yield* HttpServerRequest;
        console.log("[Api] fetch", request.method, request.url);
        console.log("[Api] headers", JSON.stringify(request.headers));
        if (request.url.startsWith("/eval")) {
          if (request.method === "POST") {
            const body = yield* request.text;

            const agent = agents.getByName("sandbox");
            return yield* agent.eval(body).pipe(
              Effect.map((response) => HttpServerResponse.text(response)),
              Effect.catch(() =>
                Effect.succeed(
                  HttpServerResponse.text("Internal Server Error", {
                    status: 500,
                  }),
                ),
              ),
            );
          }
        } else if (request.url.startsWith("/connect/")) {
          // connect to a Durable Object web socket
          const agentId = request.url.split("/").pop()!;
          console.log("[Api] /connect/ agentId =", agentId);
          const agent = agents.getByName(agentId);
          const response = yield* agent.fetch(request);
          return response;
        } else if (request.url.startsWith("/room/")) {
          const upgradeHeader = request.headers.upgrade;
          const roomId = request.url.split("/").pop()!;
          console.log(
            "[Api] /room/ roomId =",
            roomId,
            "upgrade =",
            upgradeHeader,
            "method =",
            request.method,
          );
          if (!upgradeHeader || upgradeHeader !== "websocket") {
            console.log("[Api] rejecting: no upgrade header or not websocket");
            return HttpServerResponse.text(
              "Worker expected Upgrade: websocket",
              {
                status: 426,
              },
            );
          } else if (request.method !== "GET") {
            console.log("[Api] rejecting: method not GET");
            return HttpServerResponse.text("Method not allowed", {
              status: 405,
            });
          }
          console.log("[Api] forwarding to Room DO");
          const room = rooms.getByName(roomId);
          const response = yield* room.fetch(request);
          console.log("[Api] Room DO response status =", response.status);
          return response;
        }
        return HttpServerResponse.text("Hello World", { status: 200 });
      }),
    };
  }),
) {}
