/**
 * The HTTP front of the conformance suite: a Docker service on the control
 * plane's network that calls the Durable Objects through `Rivet.Client`.
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

export default class Front extends Docker.Service<Front>()(
  "RivetFront",
  Effect.gen(function* () {
    const cluster = yield* Rivet.Cluster;
    return {
      main: import.meta.url,
      port: 3000,
      ports: [{ external: FRONT_PORT, internal: 3000 }],
      networks: cluster.network === undefined ? [] : [{ name: cluster.network.name }],
      // Only the nodes load RivetKit; the front reaches actors over HTTP.
      build: { input: { external: ["rivetkit", /^rivetkit\//, /^@rivetkit\//] } },
    };
  }).pipe(Effect.provide(Cluster)),
  Effect.gen(function* () {
    const counters = yield* Rivet.Client(Counter);
    const greeters = yield* Rivet.Client(Greeter);
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
        return yield* conformance;
      }),
    };
  }).pipe(Effect.provide(Cluster)),
) {}
