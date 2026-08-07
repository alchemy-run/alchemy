/**
 * A VPC-attached Lambda fronting the fleet.
 *
 * celld nodes serve on a private network, so the conformance spec cannot
 * reach them directly. This Lambda re-exposes the SAME `conformanceFetch`
 * surface, driving the Durable Objects through the REMOTE stub over the
 * fleet gateway — which makes the celld run additionally a test of the
 * remote transport that the Cloudflare run exercises in-process.
 */
import * as AWS from "@/AWS";
import * as Celld from "@/Celld";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { Counter } from "../counter.ts";
import { conformanceFetch } from "../routes.ts";
import { CounterLive } from "./worker.ts";

export default class ConformanceApi extends AWS.Lambda.Function<ConformanceApi>()(
  "ConformanceApi",
  // Cold cells take a few seconds on first touch (lease CAS + SQLite
  // restore + replicate-before-ack); the 3s default is too tight.
  { main: import.meta.url, timeout: Duration.seconds(30) },
  Effect.gen(function* () {
    const counters = yield* Counter;
    return { fetch: conformanceFetch(counters) };
  }).pipe(
    // No props = client mode: this Lambda deploys nothing, it only
    // resolves the remote transport.
    Effect.provide(CounterLive.pipe(Layer.provideMerge(Celld.Worker()))),
  ),
) {}
