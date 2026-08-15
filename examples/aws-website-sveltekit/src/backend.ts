// The effectful site module: default-exports the Website class, anchored
// by `main: import.meta.url`. The engine imports it at plan time (binding
// collection — table-name env var + IAM onto the server Lambda) and the
// deployed Lambda re-imports it inside the SvelteKit server bundle so
// server code can dispatch the backend's methods in-process.
//
// Narrow subpath imports only (`alchemy/AWS/DynamoDB`, not `alchemy/AWS`):
// this module is bundled into the framework server build and evaluated by
// the Vite dev server — the provider barrel would drag the whole IaC
// engine along with it.
import * as DynamoDB from "alchemy/AWS/DynamoDB";
import { QueueEventSource } from "alchemy/AWS/Lambda/QueueEventSource";
import * as SQS from "alchemy/AWS/SQS";
import { SvelteKit } from "alchemy/AWS/Website";
import { remote } from "alchemy/ProviderMode";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

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
 * `enqueue` method) and CONSUMES it — the consumer deploys as a sibling
 * effect Lambda from this same module, with the event-source mapping and
 * its IAM targeting the sibling (the framework-built site Lambda stays
 * fetch-only). Deliberately NOT `remote()`: under `alchemy dev` the queue,
 * its event-source mapping, and the consumer all run together in the local
 * Lambda emulator (a real queue cannot feed an emulated consumer).
 */
export const Jobs = SQS.Queue("Jobs", {
  // Lambda event-source polling needs the visibility timeout to cover the
  // consumer function's timeout with headroom.
  visibilityTimeout: "2 minutes",
});

/**
 * One Lambda serves the SvelteKit app AND the Effect program's backend.
 * The program's methods are the API surface for TRUSTED callers:
 * SvelteKit's own server code (`+page.server.ts` load + form actions,
 * `+server.ts` routes) dispatches them in-process through
 * `createClient(Backend)` — the value form — in the deployed Lambda and
 * in `vite dev` alike. Those framework transports are what the browser
 * talks to.
 */
export default class Site extends SvelteKit<Site>()(
  "SvelteKitSite",
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

    // The async leg's CONSUMER — a queue listener on the SAME class. At
    // plan time this deploys the sibling effect Lambda
    // (`SvelteKitSite-Handlers`) with the event-source mapping targeting
    // it; at runtime the sibling dispatches each SQS batch here. Each
    // message bumps the `processed-count` item and records
    // `processed-last` in DynamoDB, where the `processed` method
    // reads them back.
    yield* SQS.consumeQueueMessages(queue, (records) =>
      records.pipe(
        Stream.runForEach(Effect.fn(function* (record) {
            const count = Number((yield* readItem("processed-count", "count")) ?? "0");
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
      /** Send a message to the queue (behind the `enqueue` form action). */
      enqueue: Effect.fn(function* (message: string) {
          yield* sendMessage({ MessageBody: message }).pipe(Effect.orDie);
        }),
      /** Read the consumer's async state (served by GET /api/processed). */
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
