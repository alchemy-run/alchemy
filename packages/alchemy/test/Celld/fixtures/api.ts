import * as AWS from "@/AWS";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import * as Celld from "@/Celld";
import * as Layer from "effect/Layer";
import { Counter, CounterLive } from "./counter.ts";
import { CellsWorker } from "./worker.ts";

/**
 * The Lambda caller: `yield* Counter` returns the same namespace handle the
 * fleet impl sees — here it resolves to the remote stub over the fleet
 * gateway (with the VPC attachment + connection env registered on the
 * Lambda through the binding channel).
 */
export default class Api extends AWS.Lambda.Function<Api>()(
  "Api",
  // Cold cells take a few seconds on first touch (lease CAS + SQLite
  // restore + replicate-before-ack) — the 3s Lambda default is too tight.
  { main: import.meta.url, timeout: Duration.seconds(30) },
  Effect.gen(function* () {
    const counters = yield* Counter;

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.url, "http://api");
        const [root, name, action] = url.pathname
          .split("/")
          .filter((s) => s.length > 0);
        if (root !== "counter" || !name || !action) {
          return HttpServerResponse.text("Not Found", { status: 404 });
        }
        const counter = counters.getByName(name);
        switch (action) {
          case "increment": {
            const value = yield* counter.increment().pipe(Effect.orDie);
            return yield* HttpServerResponse.json({ value });
          }
          case "get": {
            const value = yield* counter.get().pipe(Effect.orDie);
            return yield* HttpServerResponse.json({ value });
          }
          case "fail": {
            const result = yield* counter.fail().pipe(
              Effect.map(() => ({ tag: "unexpected-success" })),
              Effect.catch((error) =>
                Effect.succeed({ tag: (error as { _tag?: string })?._tag }),
              ),
            );
            return yield* HttpServerResponse.json(result);
          }
          case "tick": {
            const n = Number(url.searchParams.get("n") ?? "3");
            // Collect the streamed values — proves the NDJSON stream decode
            // across the fleet gateway hop.
            const values = yield* Stream.runCollect(counter.tick(n)).pipe(
              Effect.orDie,
            );
            return yield* HttpServerResponse.json({ values: [...values] });
          }
          case "worker": {
            // The fleet's own worker route (`Celld.Worker` fetch) — user
            // routes fall through the gateway unauthenticated.
            const fleetUrl = process.env.ALCHEMY_WORKER_CellsWorker_URL;
            const client = yield* HttpClient.HttpClient;
            const response = yield* client
              .get(`${fleetUrl}/hello`)
              .pipe(Effect.orDie);
            const body = yield* response.text.pipe(Effect.orDie);
            return HttpServerResponse.text(body, {
              status: response.status,
            });
          }
          case "probe": {
            // Raw gateway call — bypasses the stub's decode so tests can
            // observe the exact status/body the fleet returns.
            const method = url.searchParams.get("m") ?? "increment";
            const fleetUrl = process.env.ALCHEMY_WORKER_CellsWorker_URL;
            const secretRaw = process.env.ALCHEMY_WORKER_CellsWorker_SECRET;
            const secret = (() => {
              try {
                const parsed = JSON.parse(secretRaw ?? "");
                return typeof parsed === "object" && parsed?._tag === "Redacted"
                  ? String(parsed.value)
                  : String(secretRaw);
              } catch {
                return String(secretRaw);
              }
            })();
            const client = yield* HttpClient.HttpClient;
            const response = yield* client
              .execute(
                HttpClientRequest.post(
                  `${fleetUrl}/Counter/${encodeURIComponent(name)}/__rpc__/${method}`,
                ).pipe(
                  HttpClientRequest.setHeader("x-alchemy-fleet-secret", secret),
                  HttpClientRequest.bodyText("[]", "application/json"),
                ),
              )
              .pipe(Effect.orDie);
            const body = yield* response.text.pipe(Effect.orDie);
            return yield* HttpServerResponse.json({
              status: response.status,
              headers: response.headers,
              body,
            });
          }
          default:
            return HttpServerResponse.text("Not Found", { status: 404 });
        }
      }),
    };
  }).pipe(
    // The ref supplies the host: it proves (at the stack) the worker is
    // deployed to celld, registers the caller binding, and carries the
    // remote transport. This Lambda deploys nothing.
    Effect.provide(
      CounterLive.pipe(Layer.provide(Celld.Worker.ref(CellsWorker))),
    ),
  ),
) {}
