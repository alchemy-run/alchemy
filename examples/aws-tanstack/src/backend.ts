// The effectful site module: default-exports the Website class, anchored
// by `main: import.meta.url`. The engine imports it at plan time (binding
// collection — table/queue env vars + IAM onto the server Lambda) and the
// deployed Lambda re-imports it inside the TanStack Start server bundle
// so server functions can dispatch the backend's methods in-process.
//
// Narrow subpath imports only (`alchemy/AWS/DynamoDB`, not `alchemy/AWS`):
// this module joins the TanStack Start vite graph (the generated Lambda
// entry imports it), and in dev vite's dev server evaluates every module
// in that graph — the provider barrel would drag the whole IaC engine
// along with it.
import * as DynamoDB from "alchemy/AWS/DynamoDB";
import { QueueEventSource } from "alchemy/AWS/Lambda/QueueEventSource";
import * as SQS from "alchemy/AWS/SQS";
import { Vite } from "alchemy/AWS/Website";
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
 * ONE deployment serves the TanStack Start app AND a typed backend:
 * `ssr: true` selects the SSR arm of `AWS.Website.Vite` — the project's
 * own vite.config.ts (TanStack Start plugin included) builds the server
 * graph, which runs on a streaming Lambda Function URL with the client
 * assets in S3 behind CloudFront.
 *
 * The program's RPC METHODS are the API surface for TRUSTED callers:
 * `createClient(Backend)` dispatches them directly in-process from the
 * TanStack server functions in src/server/visits.ts — the browser only
 * ever talks to those server functions over Start's own transport. No
 * routes, no URL parsing, no envelope handling: just typed methods.
 *
 * `main: import.meta.url` anchors this module — the engine imports it for
 * plan-time binding collection and the generated Lambda entry re-imports
 * it inside the vite graph.
 */
export default class Site extends Vite<Site>()(
  "Website",
  {
    ssr: true,
    main: import.meta.url,
    forceDestroy: true,
  },
  Effect.gen(function* () {
    // Init: runs at plan time in the engine (collects the DynamoDB/SQS
    // bindings) and again inside the Lambda on first request (builds the
    // runtime clients).
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
    // (`Website-Handlers`) with the event-source mapping targeting it; at
    // runtime the sibling dispatches each SQS batch here. Each message
    // bumps the `processed-count` item and records `processed-last` in
    // DynamoDB, where the `processed` method reads them back.
    yield* SQS.consumeQueueMessages(queue, (records) =>
      records.pipe(
        Stream.runForEach(Effect.fn(function* (record) {
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
      // RPC methods — the DynamoDB-backed visit counter. Invoked directly
      // (no HTTP) by the value-form client inside server functions and
      // SSR loaders.
      visits: Effect.fn(function* () {
          return Number((yield* readItem("count", "count")) ?? "0");
        }),
      bump: Effect.fn(function* () {
          const count = Number((yield* readItem("count", "count")) ?? "0") + 1;
          yield* putItem({
            Item: { pk: { S: "count" }, count: { N: String(count) } },
          }).pipe(Effect.orDie);
          return count;
        }),
      // The async leg's producer — sends a message to the queue; the
      // consumer above catches up asynchronously on the sibling Lambda.
      enqueue: Effect.fn(function* (message: string) {
          yield* sendMessage({ MessageBody: message }).pipe(Effect.orDie);
        }),
      // Read the consumer's async state.
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
