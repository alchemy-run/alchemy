/**
 * A VPC-attached Lambda fronting the Rivet cluster.
 *
 * The engine and runner live on the cluster's private network, so the
 * conformance spec cannot reach the actors directly. This Lambda
 * re-exposes the SAME `conformanceFetch` surface, driving the Durable
 * Objects through the REMOTE stub over the Rivet gateway protocol.
 *
 * `Rivet.Worker.ref(ConformanceWorker)` supplies the host: it proves (at
 * the stack) that the worker is deployed to Rivet, registers the caller
 * binding, and carries the gateway transport.
 */
import * as AWS from "@/AWS";
import * as Rivet from "@/Rivet";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { Counter, CounterLive } from "../counter.ts";
import { conformanceFetch } from "../routes.ts";
import { ConformanceWorker } from "./cluster.ts";

export default class ConformanceApi extends AWS.Lambda.Function<ConformanceApi>()(
  "ConformanceApi",
  // Actor cold starts ride a lease + gateway hop; 3s default is too tight.
  { main: import.meta.url, timeout: Duration.seconds(30) },
  Effect.gen(function* () {
    const counters = yield* Counter;
    return { fetch: conformanceFetch(counters) };
  }).pipe(
    Effect.provide(
      CounterLive.pipe(Layer.provide(Rivet.Worker.ref(ConformanceWorker))),
    ),
  ),
) {}
