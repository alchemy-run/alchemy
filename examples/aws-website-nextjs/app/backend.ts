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
import { Nextjs } from "alchemy/AWS/Website";
import { remote } from "alchemy/ProviderMode";
import * as Effect from "effect/Effect";

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
    };
  }).pipe(Effect.provide([DynamoDB.GetItemHttp, DynamoDB.PutItemHttp])),
) {}
