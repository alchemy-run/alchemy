/**
 * A VPC-attached Lambda fronting the fleet.
 *
 * celld nodes serve on a private network, so the conformance spec cannot
 * reach them directly. This Lambda re-exposes the SAME `conformanceFetch`
 * surface, driving the Durable Objects through the REMOTE stub over the
 * fleet gateway — the celld run doubles as the remote-transport test.
 *
 * `Celld.Worker.ref(ConformanceWorker)` supplies the host: it proves (at
 * the stack) that the worker is deployed to celld, registers the caller
 * binding, and carries the runtime transport.
 */
import * as AWS from "@/AWS";
import * as Celld from "@/Celld";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { Counter, CounterLive } from "../counter.ts";
import { conformanceFetch } from "../routes.ts";
import { ConformanceWorker } from "./fleet.ts";

export default class ConformanceApi extends AWS.Lambda.Function<ConformanceApi>()(
  "ConformanceApi",
  // Cold cells take a few seconds on first touch (lease CAS + SQLite
  // restore + replicate-before-ack); the 3s default is too tight.
  { main: import.meta.url, timeout: Duration.seconds(30) },
  Effect.gen(function* () {
    const counters = yield* Counter;
    return { fetch: conformanceFetch(counters) };
  }).pipe(
    Effect.provide(
      CounterLive.pipe(Layer.provide(Celld.Worker.ref(ConformanceWorker))),
    ),
  ),
) {}
