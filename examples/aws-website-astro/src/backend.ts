// The effectful site module: default-exports the Website class, anchored
// by `main: import.meta.url`. The engine imports it at plan time (binding
// collection — table-name env var + IAM onto the server Lambda) and the
// deployed Lambda re-imports it inside the Astro server bundle to serve
// the backend's RPC methods.
//
// Narrow subpath imports only (`alchemy/AWS/DynamoDB`, not `alchemy/AWS`):
// this module is bundled into the framework server build and evaluated by
// the Astro dev server — the provider barrel would drag the whole IaC
// engine along with it.
import * as DynamoDB from "alchemy/AWS/DynamoDB";
import { Astro } from "alchemy/AWS/Website";
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
 * One Lambda serves the Astro frontend AND the Effect program's backend.
 * The program's RPC METHODS are the API surface: each method is callable
 * through `createClient` (`alchemy/client`) — in-process from Astro
 * frontmatter (the value form) and over the wire from the browser
 * (`POST /api/__rpc/<method>`, the type-only form) — in the deployed
 * Lambda and in `astro dev` alike.
 */
export default class Site extends Astro<Site>()(
  "Astro",
  {
    main: import.meta.url,
    // Only hash the files that affect the build, so unchanged sources
    // skip the Astro build (and the deploy) entirely.
    memo: {
      include: [
        "src/**",
        "public/**",
        "package.json",
        "astro.config.ts",
        "src/backend.ts",
      ],
    },
    forceDestroy: true,
  },
  Effect.gen(function* () {
    const table = yield* Visits;
    const getItem = yield* DynamoDB.GetItem(table);
    const putItem = yield* DynamoDB.PutItem(table);
    return {
      /**
       * Record one visit and return the new total — the DynamoDB-backed
       * counter behind both the SSR render and the browser button.
       */
      visit: () =>
        Effect.gen(function* () {
          const current = yield* getItem({
            Key: { pk: { S: "visits" } },
            ConsistentRead: true,
          }).pipe(Effect.orDie);
          const count = Number(current.Item?.count?.N ?? "0") + 1;
          yield* putItem({
            Item: { pk: { S: "visits" }, count: { N: String(count) } },
          }).pipe(Effect.orDie);
          return count;
        }),
    };
  }).pipe(Effect.provide([DynamoDB.GetItemHttp, DynamoDB.PutItemHttp])),
) {}
