/**
 * The driver under test, exposed over HTTP: one route per actor verb.
 *
 * Note what the Worker does NOT contain — no Durable Object class, no
 * namespace wiring, no run registry. `Cloudflare.AI.DriverCloudflare`
 * declares the runs DO inside itself and is discovered as a binding
 * because the layer yields it while building, and the whole org is ONE
 * layer provided to the init effect. A Durable Object activation
 * shares that same memoized build, which is how a charter (code, and
 * so un-serializable) reaches a run without ever crossing the wire.
 */
import * as Cloudflare from "@/Cloudflare/index.ts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import { Agents, Scribe, Supervisor } from "./DriverAgents.ts";

export default class KernelTestWorker extends Cloudflare.Worker<KernelTestWorker>()(
  "DriverCloudflareTestWorker",
  {
    main: import.meta.url,
  },
  Effect.gen(function* () {
    const scribe = yield* Scribe;
    const supervisor = yield* Supervisor;
    const gateway = yield* Cloudflare.AI.Sessions;
    const actors = { Scribe: scribe, Supervisor: supervisor };

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.url, "http://worker");
        const key = url.searchParams.get("key") ?? "default";
        const input = url.searchParams.get("input") ?? "hello";
        const actor =
          actors[(url.searchParams.get("agent") ?? "Scribe") as "Scribe"];

        // the live view: ws(s)://…/attach/<agent>/<key>
        if (url.pathname.startsWith("/attach/")) {
          const [, , agent, ...rest] = url.pathname.split("/");
          return yield* gateway.attach(agent!, rest.join("/"), request);
        }

        switch (url.pathname) {
          // admit + join: resolves at `AI.reply`, or at quiescence
          case "/dispatch": {
            // surface failures as text instead of an opaque 500 — a
            // deployed test can only be debugged through its responses
            const result = yield* Effect.exit(actor.dispatch(input, { key }));
            if (Exit.isSuccess(result)) {
              return yield* HttpServerResponse.json({ answer: result.value });
            }
            const detail = Cause.pretty(result.cause);
            yield* Effect.logError(`[fixture] dispatch failed: ${detail}`);
            return yield* HttpServerResponse.json(
              { error: detail },
              { status: 500 },
            );
          }
          // admit, fire-and-forget
          case "/send": {
            const sent = yield* Effect.exit(actor.send(input, { key }));
            if (Exit.isSuccess(sent)) {
              return yield* HttpServerResponse.json({ sent: true });
            }
            const detail = Cause.pretty(sent.cause);
            yield* Effect.logError(`[fixture] send failed: ${detail}`);
            return yield* HttpServerResponse.json(
              { error: detail },
              { status: 500 },
            );
          }
          // key-addressed input: wakes a parked run
          case "/steer": {
            yield* actor.steer(key, input);
            return yield* HttpServerResponse.json({ steered: true });
          }
          case "/settle": {
            yield* actor.settle(key, { reason: input });
            return yield* HttpServerResponse.json({ settled: true });
          }
          default:
            return HttpServerResponse.text("ok");
        }
      }),
    };
  }).pipe(Effect.provide(Agents)),
) {}
