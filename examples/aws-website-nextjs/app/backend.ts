// The effectful site module: default-exports the Website class, anchored
// by `main: import.meta.url`. The engine imports it at plan time (binding
// collection — table-name env var + IAM onto the server Lambda) and the
// route-handler mount (app/api/[[...slug]]/route.ts) imports it inside the
// OpenNext server bundle to serve the backend's RPC methods.
//
// Narrow subpath imports only (`alchemy/AWS/DynamoDB`, not `alchemy/AWS`):
// this module is compiled by Next into the server bundle — the provider
// barrel would drag the whole IaC engine along with it.
import * as DynamoDB from "alchemy/AWS/DynamoDB";
import { QueueEventSource } from "alchemy/AWS/Lambda/QueueEventSource";
import * as SQS from "alchemy/AWS/SQS";
import { Nextjs } from "alchemy/AWS/Website";
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
 * `enqueue` RPC method) and CONSUMES it — the consumer deploys as a sibling
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
 * One Lambda serves the Next.js app AND the Effect program's backend. The
 * program's RPC METHODS are the API surface: each method is callable
 * through `createClient` (`alchemy/client`) — in-process from server
 * components (the value form) and over the wire from client components
 * (`POST /api/__rpc/<method>`, the type-only form). On Next.js the wire
 * path mounts explicitly: the catch-all route handler at
 * `app/api/[[...slug]]/route.ts` (`toRouteHandler` from
 * `alchemy/serve/next`) is compiled by Next itself, so it runs in the
 * deployed OpenNext Lambda and under `next dev` alike. More-specific
 * routes like `app/api/hello/route.ts` keep winning over the catch-all —
 * Next's own routing is the fallback.
 */
export default class Site extends Nextjs<Site>()(
  "Nextjs",
  {
    main: import.meta.url,
    // Only hash the files that affect the build, so unchanged sources
    // skip the OpenNext build (and the deploy) entirely.
    memo: {
      include: [
        "app/**",
        "src/**",
        "public/**",
        "package.json",
        "next.config.mjs",
        "postcss.config.mjs",
        "open-next.config.ts",
        "tsconfig.json",
      ],
    },
    forceDestroy: true,
  },
  Effect.gen(function* () {
    const table = yield* Visits;
    const getItem = yield* DynamoDB.GetItem(table);
    const putItem = yield* DynamoDB.PutItem(table);
    const queue = yield* Jobs;
    const sendMessage = yield* SQS.SendMessage(queue);

    /** Read one string attribute from a keyed item (undefined when unset). */
    const readItem = (pk: string, attr: "count" | "value") =>
      Effect.gen(function* () {
        const current = yield* getItem({
          Key: { pk: { S: pk } },
          ConsistentRead: true,
        }).pipe(Effect.orDie);
        const item = current.Item?.[attr];
        return item && "N" in item ? item.N : item?.S;
      });

    // The async leg's CONSUMER — a queue listener on the SAME class. At
    // plan time this deploys the sibling effect Lambda (`Nextjs-Handlers`)
    // with the event-source mapping targeting it; at runtime the sibling
    // dispatches each SQS batch here. Each message bumps the
    // `processed-count` item and records `processed-last` in DynamoDB,
    // where the `processed` RPC method reads them back.
    yield* SQS.consumeQueueMessages(queue, (records) =>
      records.pipe(
        Stream.runForEach((record) =>
          Effect.gen(function* () {
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
      visits: () =>
        Effect.gen(function* () {
          const current = yield* getItem({
            Key: { pk: { S: "count" } },
            ConsistentRead: true,
          }).pipe(Effect.orDie);
          return Number(current.Item?.count?.N ?? "0");
        }),
      /** Increment the counter, persist it, and return the new count. */
      bump: () =>
        Effect.gen(function* () {
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
      /** Send a message to the queue (RPC: POST /api/__rpc/enqueue). */
      enqueue: (message: string) =>
        Effect.gen(function* () {
          yield* sendMessage({ MessageBody: message }).pipe(Effect.orDie);
        }),
      /** Read the consumer's async state (RPC: POST /api/__rpc/processed). */
      processed: () =>
        Effect.gen(function* () {
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
