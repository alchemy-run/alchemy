// The effectful site module: default-exports the Website class, anchored
// by `main: import.meta.url`. The engine imports it at plan time (binding
// collection — table-name env var + IAM onto the server Lambda) and the
// deployed Lambda re-imports it inside the Astro server bundle to serve
// `/api/*`.
//
// Narrow subpath imports only (`alchemy/AWS/DynamoDB`, not `alchemy/AWS`):
// this module is bundled into the framework server build and evaluated by
// the Astro dev server — the provider barrel would drag the whole IaC
// engine along with it.
import * as DynamoDB from "alchemy/AWS/DynamoDB";
import { Astro } from "alchemy/AWS/Website";
import { remote } from "alchemy/ProviderMode";
import { passthrough } from "alchemy/serve";
import * as Effect from "effect/Effect";
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
 * One Lambda serves the Astro frontend AND the Effect program's API:
 * requests matching `server.routes` (default `["/api/*"]`) reach the
 * effect `fetch` first — at the CloudFront edge, in the deployed Lambda,
 * and in `astro dev` alike (delivery is automatic for Astro). Anything the
 * program declines falls through to Astro's own pipeline.
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
        "site.ts",
      ],
    },
    forceDestroy: true,
    server: {
      environment: {
        GREETING: "Hello from Alchemy!",
      },
    },
  },
  Effect.gen(function* () {
    const table = yield* Visits;
    const getItem = yield* DynamoDB.GetItem(table);
    const putItem = yield* DynamoDB.PutItem(table);
    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        // `request.url` is path-shaped inside the effect fetch; the base
        // makes the parse total either way.
        const url = new URL(request.url, "http://site");
        if (url.pathname === "/api/visits") {
          const current = yield* getItem({
            Key: { pk: { S: "visits" } },
            ConsistentRead: true,
          }).pipe(Effect.orDie);
          const count = Number(current.Item?.count?.N ?? "0") + 1;
          yield* putItem({
            Item: { pk: { S: "visits" }, count: { N: String(count) } },
          }).pipe(Effect.orDie);
          return yield* HttpServerResponse.json({ count });
        }
        // Typed "not mine": everything else under /api/* falls through to
        // Astro's own pipeline.
        return yield* passthrough;
      }),
    };
  }).pipe(Effect.provide([DynamoDB.GetItemHttp, DynamoDB.PutItemHttp])),
) {}
