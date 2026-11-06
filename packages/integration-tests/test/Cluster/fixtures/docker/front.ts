import * as Docker from "@alchemy.run/docker";
/** The Docker suite's front: a Docker service on the database's network. */
import * as Cluster from "@alchemy.run/effect-cluster";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import { frontApp } from "../app.ts";
import { Database, FRONT_PORT } from "./cluster.ts";
import Echo from "./inline/echo.ts";
import Shout from "./inline/shout.ts";
import { Tally } from "./tally.ts";

export default class Front extends Docker.Service<Front>()(
  "ClusterFront",
  Effect.gen(function* () {
    const database = yield* Cluster.Database.Database;
    return {
      main: import.meta.url,
      port: 3000,
      ports: [{ external: FRONT_PORT, internal: 3000 }],
      networks: database.network?.kind === "docker" ? [{ name: database.network.name }] : [],
    };
  }).pipe(Effect.provide(Database)),
  Effect.gen(function* () {
    const app = yield* frontApp(Tally);
    // Classes declared inline: yielding them also deploys them.
    const echoes = yield* Echo;
    const shout = yield* Shout;
    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const [, route, text = "x"] = new URL(request.url, "http://front").pathname.split("/");
        if (route === "echo") {
          const echo = yield* echoes.getByName(text);
          return yield* HttpServerResponse.json({ value: yield* echo.Say({ text }) });
        }
        if (route === "shout") {
          const run = yield* shout.start({ text });
          return yield* HttpServerResponse.json({ value: yield* run.result });
        }
        return yield* app.fetch;
      }).pipe(
        // A failed call answers with its cause, which the tests print.
        Effect.catchCause((cause) =>
          Effect.succeed(HttpServerResponse.text(Cause.pretty(cause), { status: 500 })),
        ),
      ),
    };
  }),
) {}
