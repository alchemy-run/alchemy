/**
 * A VPC-attached Lambda fronting the Rivet cluster.
 *
 * The engine and runner live on the cluster's private network, so the
 * conformance spec cannot reach the actors directly. This Lambda
 * re-exposes the SAME `conformanceFetch` surface, driving the Durable
 * Objects through `Rivet.bindWorker`'s stub over the Rivet gateway
 * protocol.
 *
 * It also exposes `/probe-unauth/*` routes for the binding-security tests
 * (raw gateway calls with a missing / wrong engine token — the engine is
 * private, so the negative probes must originate inside the VPC too) and
 * `/probe-inits/{cell}` for the build-once test (N actions against one
 * instance, then its init count).
 */
import * as AWS from "@/AWS";
import * as Rivet from "@/Rivet";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import { type CounterShape } from "../../Cloudflare/Workers/conformance/counter.ts";
import { conformanceFetch } from "../../Cloudflare/Workers/conformance/routes.ts";
import { ConformanceWorker } from "./cluster.ts";
import type { InitProbeShape } from "./probe.ts";

export default class ConformanceApi extends AWS.Lambda.Function<ConformanceApi>()(
  "ConformanceApi",
  // Actor cold starts ride a lease + gateway hop; 3s default is too tight.
  { main: import.meta.url, timeout: Duration.seconds(30) },
  Effect.gen(function* () {
    const actors = yield* Rivet.bindWorker(ConformanceWorker);
    const counters = actors.durableObject<CounterShape>("Counter");
    const probes = actors.durableObject<InitProbeShape>("InitProbe");
    const conformance = conformanceFetch(counters);
    // The engine endpoint, read straight off the worker's attributes
    // (stamped into this Lambda's env at plan, read back at runtime).
    const endpoint = yield* yield* (yield* ConformanceWorker).endpoint;

    // Raw gateway probe against the engine's guard service — bypasses the
    // stub so the tests can observe the exact status the engine answers
    // with when the token is missing or wrong.
    const probe = (token?: string) =>
      Effect.gen(function* () {
        if (endpoint === undefined) {
          return yield* Effect.die(new Error("engine endpoint unbound"));
        }
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
        if (root === "probe-inits" && kind !== undefined) {
          const probe = probes.getByName(kind);
          const touches = Number(url.searchParams.get("n") ?? "5");
          for (let i = 0; i < touches; i++) {
            yield* probe.touch().pipe(Effect.orDie);
          }
          return yield* HttpServerResponse.json({
            inits: yield* probe.inits().pipe(Effect.orDie),
          });
        }
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
