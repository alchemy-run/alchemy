import * as Docker from "@alchemy.run/docker";
import * as Cluster from "@alchemy.run/effect-cluster";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import { AuthClient, MemberToken } from "./Auth.ts";
import { Database } from "./Cluster.ts";
import { Answer, Invite } from "./Invite.ts";
import { Room } from "./Room.ts";

export default class Api extends Docker.Service<Api>()(
  "Api",
  Effect.gen(function* () {
    const database = yield* Cluster.Database.Database;
    return {
      main: import.meta.url,
      port: 3000,
      ports: [{ external: 8080, internal: 3000 }],
      networks: database.network?.kind === "docker" ? [{ name: database.network.name }] : [],
    };
  }).pipe(Effect.provide(Database)),
  Effect.gen(function* () {
    const rooms = yield* Room;
    const invites = yield* Invite;
    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.url, "http://api");
        if (url.pathname === "/invite") {
          const run = yield* invites.start({
            room: url.searchParams.get("room") ?? "lobby",
            guest: url.searchParams.get("guest") ?? "guest",
          });
          return yield* HttpServerResponse.json({ executionId: run.executionId });
        }
        if (url.pathname === "/answer") {
          const run = invites.get(url.searchParams.get("executionId") ?? "");
          yield* run.signal(Answer, url.searchParams.get("accept") === "true");
          return yield* HttpServerResponse.json(yield* run.status);
        }
        const [, room = "lobby"] = url.pathname.split("/");
        const target = yield* rooms.getByName(room);
        return yield* target.Join().pipe(
          Effect.provideService(MemberToken, request.headers["x-member"] ?? ""),
          Effect.flatMap((members) => HttpServerResponse.json({ members })),
          Effect.catchTag("Unauthorized", () =>
            HttpServerResponse.json({ error: "sign in" }, { status: 401 }),
          ),
        );
      }).pipe(Effect.provide(AuthClient), Effect.orDie),
    };
  }),
) {}
