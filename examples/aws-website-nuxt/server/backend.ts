// The effectful site module: default-exports the Website class, anchored
// by `main: import.meta.url`. The engine imports it at plan time (binding
// collection — table-name env var + IAM onto the server Lambda), and the
// nitro server routes in server/api/ import it inside the nitro server
// bundle to dispatch the backend's methods in-process. The middleware
// mount in server/middleware/alchemy.ts imports it too — same module id,
// same class, one runtime.
//
// Narrow subpath imports only (`alchemy/AWS/DynamoDB`, not `alchemy/AWS`):
// this module is compiled by nitro into the server bundle and evaluated by
// the nitro dev worker — the provider barrel would drag the whole IaC
// engine along with it.
import * as DynamoDB from "alchemy/AWS/DynamoDB";
import { QueueEventSource } from "alchemy/AWS/Lambda/QueueEventSource";
import * as SQS from "alchemy/AWS/SQS";
import { Nuxt } from "alchemy/AWS/Website";
import { remote } from "alchemy/ProviderMode";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

/**
 * DynamoDB table bound by the site's program. `remote()` keeps the table
 * REAL even under `alchemy dev` — the dev server's capability clients hit
 * AWS directly with your ambient credentials.
 */
export const Visits = DynamoDB.Table("Visits", {
  partitionKey: "pk",
  attributes: { pk: "S" },
}).pipe(remote());

/**
 * SQS queue for the async leg: the site's program both produces to it (the
 * `enqueue` method and the effect fetch's /api/enqueue route) and CONSUMES
 * it — single-handler delivery (Serve/DESIGN.md, AWS phase 4): the
 * event-source mapping and its IAM target the site's OWN server Lambda,
 * whose generated entry dispatches SQS batches through the consumer
 * registered below (no sibling function deploys). Deliberately NOT
 * `remote()`: under `alchemy dev` the queue, its event-source mapping, and
 * the consumer all run together in the local Lambda emulator (a real queue
 * cannot feed an emulated consumer).
 */
export const Jobs = SQS.Queue("Jobs", {
  // Lambda event-source polling needs the visibility timeout to cover the
  // consumer function's timeout with headroom.
  visibilityTimeout: "2 minutes",
});

/**
 * ONE Lambda serves the Nuxt app AND a typed backend — the maximal AWS
 * shape (Serve/DESIGN.md "MaxSite", minus DOs/Workflows which AWS has no
 * analogue for): an Effect `fetch` API (including a streaming route and a
 * request-scope finalizer route), a queue produced to AND consumed on the
 * same Lambda, and value-form methods for nitro's own server routes in
 * server/api/ via `createClient(Backend)` (trusted, in-process dispatch —
 * no public wire; the browser talks to the nitro routes).
 *
 * HTTP composition lives in server/middleware/alchemy.ts — the mount.
 * Everything platform-shaped (the queue consumer's event-source mapping)
 * derives from the `yield*` registrations below; nothing is configured
 * elsewhere.
 */
export default class Site extends Nuxt<Site>()(
  "NuxtSite",
  {
    main: import.meta.url,
    forceDestroy: true,
  },
  Effect.gen(function* () {
    const table = yield* Visits;
    const getItem = yield* DynamoDB.GetItem(table);
    const putItem = yield* DynamoDB.PutItem(table);
    const queue = yield* Jobs;
    const sendMessage = yield* SQS.SendMessage(queue);

    /** Read one string attribute from a keyed item (undefined when unset). */
    const readItem = Effect.fn(function* (pk: string, attr: "count" | "value") {
      const current = yield* getItem({
        Key: { pk: { S: pk } },
        ConsistentRead: true,
      }).pipe(Effect.orDie);
      const item = current.Item?.[attr];
      return item && "N" in item ? item.N : item?.S;
    });

    /** Write one string attribute to a keyed item. */
    const writeValue = Effect.fn(function* (pk: string, value: string) {
      yield* putItem({
        Item: { pk: { S: pk }, value: { S: value } },
      }).pipe(Effect.orDie);
    });

    // The async leg's CONSUMER — a queue listener on the SAME class. At
    // plan time the event-source mapping (and its consume IAM) registers
    // against the site's own server Lambda; at runtime the generated
    // single-handler entry dispatches each SQS batch here. Each message
    // bumps the `processed-count` item and records `processed-last` in
    // DynamoDB, where the `processed` method reads them back.
    yield* SQS.consumeQueueMessages(queue, (records) =>
      records.pipe(
        Stream.runForEach(
          Effect.fn(function* (record) {
            const count = Number(
              (yield* readItem("processed-count", "count")) ?? "0",
            );
            yield* putItem({
              Item: {
                pk: { S: "processed-count" },
                count: { N: String(count + 1) },
              },
            }).pipe(Effect.orDie);
            yield* putItem({
              Item: { pk: { S: "processed-last" }, value: { S: record.body } },
            }).pipe(Effect.orDie);
          }),
        ),
      ),
    );

    return {
      // ── Effect HTTP API (paths the middleware mount routes here) ──
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.url, "http://site");

        // Streaming route: the response body streams through the single
        // `streamifyResponse` wrap (the request scope ejects to the
        // stream's lifetime).
        if (url.pathname === "/api/stream") {
          const n = Number(url.searchParams.get("n") ?? "3");
          const stream = Stream.range(0, n - 1).pipe(
            Stream.map((i) => `${i}\n`),
            Stream.encodeText,
          );
          return HttpServerResponse.stream(stream, {
            headers: { "content-type": "text/plain" },
          });
        }

        // Request-scope finalizer: settles INLINE before the response on
        // AWS (Lambda semantics); observed via /api/kv?key=finalizer-last.
        if (url.pathname === "/api/finalizer") {
          const value = url.searchParams.get("v") ?? "ran";
          yield* Effect.addFinalizer(() =>
            writeValue("finalizer-last", value).pipe(Effect.ignore),
          );
          return yield* HttpServerResponse.json({ registered: value });
        }

        // Queue producer over HTTP (the nitro route stays covered through
        // the value-form `enqueue` method).
        if (url.pathname === "/api/enqueue") {
          const message = url.searchParams.get("m") ?? "job";
          yield* sendMessage({ MessageBody: message }).pipe(Effect.orDie);
          return yield* HttpServerResponse.json({ sent: message });
        }

        // Observability for the async legs (consumer, finalizer).
        if (url.pathname === "/api/kv") {
          const key = url.searchParams.get("key") ?? "";
          const value =
            (yield* readItem(key, "count")) ?? (yield* readItem(key, "value"));
          return yield* HttpServerResponse.json({ value: value ?? null });
        }

        // Reached only through the mount's admin gate (the middleware).
        if (url.pathname === "/api/admin/secret") {
          return yield* HttpServerResponse.json({ admin: true });
        }

        return HttpServerResponse.empty({ status: 404 });
      }),

      // ── Value-form methods (createClient from nitro server routes) ──
      /** Read the visit counter (0 when unset). */
      visits: Effect.fn(function* () {
        const current = yield* getItem({
          Key: { pk: { S: "count" } },
          ConsistentRead: true,
        }).pipe(Effect.orDie);
        return Number(current.Item?.count?.N ?? "0");
      }),
      /** Increment the counter, persist it, and return the new count. */
      bump: Effect.fn(function* () {
        const current = yield* getItem({
          Key: { pk: { S: "count" } },
          ConsistentRead: true,
        }).pipe(Effect.orDie);
        const count = Number(current.Item?.count?.N ?? "0") + 1;
        yield* putItem({
          Item: { pk: { S: "count" }, count: { N: String(count) } },
        }).pipe(Effect.orDie);
        return count;
      }),
      /** Send a message to the queue (server/api/jobs.post.ts). */
      enqueue: Effect.fn(function* (message: string) {
        yield* sendMessage({ MessageBody: message }).pipe(Effect.orDie);
      }),
      /** Read the consumer's async state (server/api/jobs.get.ts). */
      processed: Effect.fn(function* () {
        const count = yield* readItem("processed-count", "count");
        const last = yield* readItem("processed-last", "value");
        return { count: Number(count ?? "0"), last: last ?? null };
      }),
    };
  }).pipe(
    Effect.provide([
      DynamoDB.GetItemHttp,
      DynamoDB.PutItemHttp,
      SQS.SendMessageHttp,
    ]),
    Effect.provide(QueueEventSource),
  ),
) {}
