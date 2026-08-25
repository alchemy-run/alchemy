/**
 * A VPC-attached Lambda fronting the fleet.
 *
 * celld nodes serve on a private network, so the conformance spec cannot
 * reach them directly. This Lambda re-exposes the SAME `conformanceFetch`
 * surface, driving the Durable Objects through `Celld.bindWorker`'s
 * schemaless stub over the fleet gateway — the celld run doubles as the
 * remote-transport test.
 *
 * It also exposes `/probe-unauth/*` routes for the binding-security tests:
 * raw gateway calls with a missing / wrong secret header (the fleet is
 * private, so the negative probes must originate inside the VPC too).
 */
import * as AWS from "@/AWS";
import * as Celld from "@/Celld";
import * as Config from "effect/Config";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import { type CounterShape } from "../counter.ts";
import { conformanceFetch } from "../routes.ts";
import { ConformanceWorker } from "./fleet.ts";

export default class ConformanceApi extends AWS.Lambda.Function<ConformanceApi>()(
  "ConformanceApi",
  // Cold cells take a few seconds on first touch (lease CAS + SQLite
  // restore + replicate-before-ack); the 3s default is too tight.
  { main: import.meta.url, timeout: Duration.seconds(30) },
  Effect.gen(function* () {
    const cells = yield* Celld.bindWorker(ConformanceWorker);
    const counters = cells.durableObject<CounterShape>("Counter");
    const conformance = conformanceFetch(counters);

    // Raw, unauthenticated gateway probe — bypasses the stub so the tests
    // can observe the exact status/body the fleet answers with.
    const probe = (path: string, secret?: string) =>
      Effect.gen(function* () {
        const fleetUrl = yield* Config.string(
          "ALCHEMY_WORKER_ConformanceWorker_URL",
        ).pipe(Effect.orDie);
        const client = yield* HttpClient.HttpClient;
        const base = HttpClientRequest.post(`${fleetUrl}${path}`).pipe(
          HttpClientRequest.bodyText("[]", "application/json"),
        );
        const response = yield* client
          .execute(
            secret === undefined
              ? base
              : base.pipe(
                  HttpClientRequest.setHeader("x-alchemy-fleet-secret", secret),
                ),
          )
          .pipe(Effect.orDie);
        const body = yield* response.text.pipe(Effect.orDie);
        return { status: response.status, body };
      });

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.url, "http://api");
        const [root, kind] = url.pathname
          .split("/")
          .filter((s) => s.length > 0);
        if (root === "probe-unauth") {
          switch (kind) {
            case "missing":
              return yield* HttpServerResponse.json(
                yield* probe("/Counter/probe/__rpc__/get"),
              );
            case "wrong":
              return yield* HttpServerResponse.json(
                yield* probe("/Counter/probe/__rpc__/get", "wrong-secret"),
              );
            case "public": {
              // The user's own fetch surface serves without any header.
              const fleetUrl = yield* Config.string(
                "ALCHEMY_WORKER_ConformanceWorker_URL",
              ).pipe(Effect.orDie);
              const client = yield* HttpClient.HttpClient;
              const response = yield* client
                .get(`${fleetUrl}/kv/probe-public/get`)
                .pipe(Effect.orDie);
              const body = yield* response.text.pipe(Effect.orDie);
              return yield* HttpServerResponse.json({
                status: response.status,
                body,
              });
            }
            default:
              return HttpServerResponse.text("Not Found", { status: 404 });
          }
        }
        return yield* conformance;
      }),
    };
  }),
) {}
