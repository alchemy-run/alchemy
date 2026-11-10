import * as Docker from "@alchemy.run/docker";
import * as Rivet from "@alchemy.run/rivet";
import * as Effect from "effect/Effect";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Schema from "effect/Schema";
import { Cluster } from "./cluster.ts";
import Room from "./room.ts";

const Message = Schema.Struct({ author: Schema.String, text: Schema.String });

export default class Api extends Docker.Service<Api>()(
  "Api",
  Effect.gen(function* () {
    const cluster = yield* Rivet.Cluster;
    return {
      main: import.meta.url,
      port: 3000,
      ports: [{ external: 3000, internal: 3000 }],
      networks: cluster.network?.kind === "docker" ? [{ name: cluster.network.name }] : [],
    };
  }).pipe(Effect.provide(Cluster)),
  Effect.gen(function* () {
    const rooms = yield* Room;
    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const [, name, action] = new URL(request.url, "http://api").pathname.split("/");
        const room = rooms.getByName(name ?? "lobby");
        if (action === "join") {
          return yield* HttpServerResponse.json({ visitors: yield* room.join() });
        }
        if (action === "messages" && request.method === "POST") {
          return yield* HttpServerRequest.schemaBodyJson(Message).pipe(
            Effect.flatMap((message) => room.post(message.author, message.text)),
            Effect.as(HttpServerResponse.empty({ status: 201 })),
            Effect.catchTag("SchemaError", () =>
              Effect.succeed(HttpServerResponse.empty({ status: 400 })),
            ),
          );
        }
        if (action === "messages") {
          return yield* HttpServerResponse.json(yield* room.messages());
        }
        return HttpServerResponse.empty({ status: 404 });
      }),
    };
  }),
) {}
