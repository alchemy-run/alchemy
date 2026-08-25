/**
 * A VPC-attached Lambda fronting the Rivet cluster.
 *
 * The engine and runner live on the cluster's private network, so the
 * conformance spec cannot reach the actors directly. This Lambda
 * re-exposes the SAME `conformanceFetch` surface, driving the Durable
 * Objects through `Rivet.bindWorker`'s stub over the Rivet gateway
 * protocol.
 *
 * It also exposes `/probe-unauth/*` routes for the binding-security tests:
 * raw gateway calls with a missing / wrong engine token (the engine is
 * private, so the negative probes must originate inside the VPC too).
 */
import * as AWS from "@/AWS";
import * as Rivet from "@/Rivet";
import * as Config from "effect/Config";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import { type CounterShape } from "../counter.ts";
import { conformanceFetch } from "../routes.ts";
import { ConformanceWorker } from "./cluster.ts";

export default class ConformanceApi extends AWS.Lambda.Function<ConformanceApi>()(
  "ConformanceApi",
  // Actor cold starts ride a lease + gateway hop; 3s default is too tight.
  { main: import.meta.url, timeout: Duration.seconds(30) },
  Effect.gen(function* () {
    const actors = yield* Rivet.bindWorker(ConformanceWorker);
    const counters = actors.durableObject<CounterShape>("Counter");
    const conformance = conformanceFetch(counters);

    // Raw gateway probe against the engine's guard service — bypasses the
    // stub so the tests can observe the exact status the engine answers
    // with when the token is missing or wrong.
    const probe = (token?: string) =>
      Effect.gen(function* () {
        const endpoint = yield* Config.string(
          "ALCHEMY_WORKER_ConformanceWorker_URL",
        ).pipe(Effect.orDie);
        const params = new URLSearchParams({
          "rvt-namespace": "default",
          "rvt-method": "getOrCreate",
          "rvt-key": "probe",
          "rvt-runner": "default",
          ...(token === undefined ? {} : { "rvt-token": token }),
        });
        const client = yield* HttpClient.HttpClient;
        const response = yield* client
          .execute(
            HttpClientRequest.post(
              `${endpoint.replace(/\/+$/, "")}/gateway/Counter/action/get?${params.toString()}`,
            ).pipe(
              HttpClientRequest.bodyText(
                JSON.stringify({ args: [] }),
                "application/json",
              ),
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
              return yield* HttpServerResponse.json(yield* probe());
            case "wrong":
              return yield* HttpServerResponse.json(
                yield* probe("wrong-token"),
              );
            default:
              return HttpServerResponse.text("Not Found", { status: 404 });
          }
        }
        return yield* conformance;
      }),
    };
  }),
) {}
