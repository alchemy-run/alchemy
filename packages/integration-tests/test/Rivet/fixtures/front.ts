/**
 * The HTTP front of the conformance suite: a Docker service on the control
 * plane's network that calls the Durable Objects through the gateway.
 */
import * as Docker from "@alchemy.run/docker";
import * as Rivet from "@alchemy.run/rivet";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import { conformanceFetch } from "../../Cloudflare/Workers/conformance/routes.ts";
import { Cluster, FRONT_PORT } from "./cluster.ts";
import Counter from "./counter.ts";
import Greeter from "./greeter.ts";
import Tally from "./tally.ts";

export default class Front extends Docker.Service<Front>()(
  "RivetFront",
  Effect.gen(function* () {
    const cluster = yield* Rivet.Cluster;
    return {
      main: import.meta.url,
      port: 3000,
      ports: [{ external: FRONT_PORT, internal: 3000 }],
      networks: cluster.network?.kind === "docker" ? [{ name: cluster.network.name }] : [],
      // Only the nodes load RivetKit; the front reaches actors over HTTP.
      build: { input: { external: ["rivetkit", /^rivetkit\//, /^@rivetkit\//] } },
    };
  }).pipe(Effect.provide(Cluster)),
  Effect.gen(function* () {
    const counters = yield* Counter;
    const greeters = yield* Greeter;
    const tallies = yield* Tally;
    const conformance = conformanceFetch(counters);
    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.url, "http://front");
        const [group, name] = url.pathname.split("/").filter((segment) => segment.length > 0);
        if (group === "greet" && name !== undefined) {
          const greeting = yield* greeters.getByName("front").greet(name);
          return yield* HttpServerResponse.json({ greeting });
        }
        // `n` concurrent increments on one instance; returns its final count.
        if (group === "race" && name !== undefined) {
          const n = Number(url.searchParams.get("n") ?? "50");
          const tally = tallies.getByName(name);
          yield* Effect.forEach(
            Array.from({ length: n }, () => tally.increment("count")),
            (call) => call,
            { concurrency: "unbounded", discard: true },
          );
          return yield* HttpServerResponse.json({ count: yield* tally.read("count") });
        }
        // A slow transaction racing `n` increments, then a rolled-back one.
        if (group === "transaction" && name !== undefined) {
          const n = Number(url.searchParams.get("n") ?? "10");
          const tally = tallies.getByName(name);
          yield* Effect.all(
            [
              tally.addSlowly("count", 100, 300),
              Effect.forEach(
                Array.from({ length: n }, () => tally.increment("count")),
                (call) => Effect.andThen(Effect.sleep("20 millis"), call),
                { concurrency: "unbounded", discard: true },
              ),
            ],
            { concurrency: "unbounded" },
          );
          const aborted = yield* tally.addThenAbort("count", 1000).pipe(
            Effect.as(false),
            Effect.catchTag("TallyAborted", () => Effect.succeed(true)),
          );
          return yield* HttpServerResponse.json({
            count: yield* tally.read("count"),
            aborted,
          });
        }
        return yield* conformance;
      }),
    };
  }),
) {}
