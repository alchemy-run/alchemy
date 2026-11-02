/** The HTTP front of the suite: a Docker service on the database's network, calling entities through the gateway. */
import * as Docker from "@alchemy.run/docker";
import * as EffectCluster from "@alchemy.run/effect-cluster";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Stream from "effect/Stream";
import { Database, FRONT_PORT } from "./cluster.ts";
import Counters from "./counter.ts";
import Greeters from "./greeter.ts";

export default class Front extends Docker.Service<Front>()(
  "EffectClusterFront",
  Effect.gen(function* () {
    const database = yield* EffectCluster.Database.Database;
    return {
      main: import.meta.url,
      port: 3000,
      ports: [{ external: FRONT_PORT, internal: 3000 }],
      networks: database.network?.kind === "docker" ? [{ name: database.network.name }] : [],
    };
  }).pipe(Effect.provide(Database)),
  Effect.gen(function* () {
    const counters = yield* Counters;
    const greeters = yield* Greeters;
    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.url, "http://front");
        const [route, id = "x", arg] = url.pathname.split("/").filter((s) => s.length > 0);
        const counter = counters(id);
        const json = (value: unknown) => HttpServerResponse.json(value);
        switch (route) {
          case "increment":
            return yield* json({ value: yield* counter.Increment({ amount: Number(arg ?? 1) }) });
          case "get":
            return yield* json({ value: yield* counter.Get() });
          case "add":
            return yield* json({ value: yield* counter.Add({ operationId: arg!, amount: 5 }) });
          case "whoami":
            return yield* json({ value: yield* counter.Whoami() });
          case "boom":
            return yield* json(
              yield* counter.Boom().pipe(
                Effect.as({ tag: "unexpected-success" }),
                Effect.catchTag("CounterBoom", (error) => Effect.succeed({ tag: error._tag })),
              ),
            );
          case "tick":
            return yield* json({
              values: [...(yield* Stream.runCollect(counter.Tick({ n: Number(arg ?? 3) })))],
            });
          case "greet":
            return yield* json({ value: yield* greeters("front").Greet({ name: id }) });
          case "ready":
            return HttpServerResponse.text("ok");
          default:
            return HttpServerResponse.text("Not Found", { status: 404 });
        }
      }).pipe(Effect.orDie),
    };
  }),
) {}
