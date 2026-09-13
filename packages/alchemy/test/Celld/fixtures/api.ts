/**
 * A VPC-attached Lambda fronting the fleet.
 *
 * celld nodes serve on a private network, so the conformance spec cannot
 * reach them directly. This Lambda re-exposes the SAME `conformanceFetch`
 * surface, driving the Durable Objects through `Celld.bindWorker`'s
 * schemaless stub over the fleet gateway — the celld run doubles as the
 * remote-transport test.
 *
 * It also exposes `/probe-unauth/*` routes for the binding-security tests
 * (raw gateway calls with a missing / wrong secret header — the fleet is
 * private, so the negative probes must originate inside the VPC too),
 * `/affinity/*` for the any-node-forwarding test, and `/worker/*` for the
 * fleet worker's own surface: `/worker/rpc` calls a worker-level RPC
 * method, and `/worker/http/<route>` forwards the SAME conformance route
 * to the worker's own `fetch` through the stub's authenticated raw fetch,
 * so every capability is also exercised in-worker with native cell access
 * (no Durable Object stub routing involved).
 */
import * as AWS from "@/AWS";
import * as Celld from "@/Celld";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import { type CounterShape } from "../../Cloudflare/Workers/conformance/counter.ts";
import { conformanceFetch } from "../../Cloudflare/Workers/conformance/routes.ts";
import { ConformanceWorker } from "./fleet.ts";
import type { ConformanceWorkerRpc } from "./worker.ts";

export default class ConformanceApi extends AWS.Lambda.Function<ConformanceApi>()(
  "ConformanceApi",
  // Cold cells take a few seconds on first touch (lease CAS + SQLite
  // restore + replicate-before-ack); the 3s default is too tight.
  { main: import.meta.url, timeout: Duration.seconds(30) },
  Effect.gen(function* () {
    const cells =
      yield* Celld.bindWorker<ConformanceWorkerRpc>(ConformanceWorker);
    const counters = cells.durableObject<CounterShape>("Counter");
    const conformance = conformanceFetch(counters);

    // Raw, unauthenticated gateway probe — bypasses the stub so the tests
    // can observe the exact status/body the fleet answers with.
    const probe = (path: string, secret?: string) =>
      Effect.gen(function* () {
        const fleetUrl = yield* cells.fleetUrl;
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

    // Affinity probe: n SEQUENTIAL increments on one cell, each over a
    // FRESH connection (`connection: close` defeats keep-alive, so every
    // request re-resolves the fleet's round-robin DNS and lands on an
    // arbitrary node). Values must come back strictly consecutive — proof
    // that every node forwards the cell to its single lease owner.
    const affinity = (cell: string, n: number) =>
      Effect.gen(function* () {
        const fleetUrl = yield* cells.fleetUrl;
        const secret = yield* cells.secret;
        const client = yield* HttpClient.HttpClient;
        const values: number[] = [];
        for (let i = 0; i < n; i++) {
          const response = yield* client
            .execute(
              HttpClientRequest.post(
                `${fleetUrl}/Counter/${encodeURIComponent(cell)}/__rpc__/increment`,
              ).pipe(
                HttpClientRequest.bodyText("[]", "application/json"),
                HttpClientRequest.setHeader(
                  "x-alchemy-fleet-secret",
                  Redacted.value(secret),
                ),
                HttpClientRequest.setHeader("connection", "close"),
              ),
            )
            .pipe(Effect.orDie);
          const body = yield* response.text.pipe(Effect.orDie);
          if (response.status !== 200) {
            return yield* Effect.die(
              new Error(`increment ${i} answered ${response.status}: ${body}`),
            );
          }
          values.push(Number(JSON.parse(body)));
        }
        return { values };
      });

    // The fleet worker's own fetch surface through the stub's authenticated
    // raw fetch: `/worker/http/<route>?<query>` becomes `/<route>?<query>`
    // on the worker, which serves it with native cell access.
    const viaWorkerHttp = (route: string) =>
      Effect.gen(function* () {
        const response = yield* cells
          .fetch(HttpClientRequest.get(route))
          .pipe(Effect.orDie);
        const body = yield* response.text.pipe(Effect.orDie);
        return { from: "fleet-worker", status: response.status, body };
      });

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.url, "http://api");
        const [root, kind] = url.pathname
          .split("/")
          .filter((s) => s.length > 0);
        if (root === "affinity" && kind !== undefined) {
          const n = Number(url.searchParams.get("n") ?? "20");
          return yield* HttpServerResponse.json(yield* affinity(kind, n));
        }
        if (root === "worker") {
          if (kind === "rpc") {
            // Worker-level RPC: a method on the fleet worker's own impl
            // shape, dispatched under `/__rpc__/{method}` by the gateway.
            const from = yield* cells.whoami().pipe(Effect.orDie);
            return yield* HttpServerResponse.json({ from });
          }
          if (kind === "http") {
            const route =
              url.pathname.replace(/^\/worker\/http(?=\/|$)/, "") + url.search;
            return yield* HttpServerResponse.json(
              yield* viaWorkerHttp(route.length === 0 ? "/" : route),
            );
          }
        }
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
              const fleetUrl = yield* cells.fleetUrl;
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
