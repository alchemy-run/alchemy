---
title: Add AI Search (AutoRAG)
description: Stand up a Cloudflare AI Search (AutoRAG) pipeline over an R2 bucket with one AiSearch call, bind it into your Worker as a typed Effect client, and answer questions over your own documents.
sidebar:
  order: 6.5
---

Cloudflare **AI Search** indexes the documents in an
R2 bucket and answers questions over them with retrieval-augmented
generation — chunking, embedding, vector search, reranking, and
generation, all managed by Cloudflare.

A working pipeline needs more than one resource: the instance itself,
plus a scoped API token so the indexer can read your R2 bucket. The
`Cloudflare.AiSearch` helper wires all of that up in a single call.
We'll use it here and unpack exactly what it creates.

## Create the R2 bucket

AI Search indexes objects from an R2 bucket, so that's the source.
Create `src/Docs.ts` with a bucket definition.

```typescript
// src/Docs.ts
import * as Cloudflare from "alchemy/Cloudflare";

export const Docs = Cloudflare.R2Bucket("Docs", {});
```

This is the bucket you'll drop Markdown, PDFs, or text files into —
AI Search picks them up on its next sync.

## Declare the AI Search pipeline

Add an `AiSearch` construct and pass the `Docs` bucket as `bucket`. That
field selects R2 as the data source.

```typescript
// src/Search.ts
import * as Cloudflare from "alchemy/Cloudflare";
import { Docs } from "./Docs.ts";

export const Search = Cloudflare.AiSearch("Search", {
  source: Docs,
});
```

`AiSearch` is a **construct**, not a single resource. Calling it expands
into several resources so you don't have to wire them up by hand.

:::note[Crawling a website instead]
Passing a URL as `source` (instead of a bucket) indexes a website by
crawling it, with optional `parse` / `crawl` / `store` options and no
service token. This tutorial focuses on the R2 source — see the
[`AiSearch` reference](/providers/cloudflare/aisearch/aisearch) for the
web-crawler options.
:::

## What the helper creates

For an R2 source, the indexer needs a service token to read your bucket.
Cloudflare only creates that token for you through the dashboard or
Wrangler — never on a programmatic API create — so `AiSearch` provisions
it as stable children of the construct:

- a least-privilege `Cloudflare.AccountApiToken` scoped to the
  **AI Search Index Engine** permission group,
- a `Cloudflare.AiSearchToken` that wraps that API token into the
  service-token shape AI Search expects,
- the `Cloudflare.AiSearchInstance` itself, with the service token's
  id wired into its `tokenId`.

So the single `AiSearch("Search", …)` call above is shorthand for
roughly this:

```typescript
const apiToken = yield* Cloudflare.AccountApiToken("Token", {
  policies: [
    {
      effect: "allow",
      permissionGroups: ["AI Search Index Engine"],
      resources: { [`com.cloudflare.api.account.${accountId}`]: "*" },
    },
  ],
});
const serviceToken = yield* Cloudflare.AiSearchToken("Token", {
  cfApiId: apiToken.tokenId,
  cfApiKey: apiToken.value,
});
const instance = yield* Cloudflare.AiSearchInstance("Instance", {
  source: Docs.bucketName,
  tokenId: serviceToken.id,
});
```

`AiSearch` translates the `source` bucket into the instance's `type: "r2"` +
`source: bucket.bucketName` for you. The value it returns **is** the
`AiSearchInstance` (with the managed `serviceToken` attached), so you can pass
it straight to anything that expects an `AiSearchInstance` — no destructuring
needed.

## Index only part of the bucket

By default AI Search indexes every object in the bucket. Pass `prefix` to
scope indexing to one key prefix, and `include` / `exclude` glob patterns
for finer control.

```diff lang="typescript"
export const Search = Cloudflare.AiSearch("Search", {
  source: Docs,
+  prefix: "docs/",
+  include: ["/docs/**"],
+  exclude: ["/docs/drafts/**"],
});
```

`prefix` limits indexing to keys under `docs/`. `include` / `exclude` are
[micromatch](https://github.com/micromatch/micromatch) glob patterns (`*`
matches within a path segment, `**` across segments; up to 10 each) — only
objects matching an `include` pattern are indexed, and `exclude` wins over
`include`.

## Reuse an existing token

If your account already has a registered AI Search service token, pass
its `tokenId` and `AiSearch` skips minting the `AccountApiToken` +
`AiSearchToken` children, wiring your token into the instance instead.

```typescript
export const Search = Cloudflare.AiSearch("Search", {
  source: Docs,
  tokenId: existingToken.id,
});
```

Otherwise the default — letting the construct provision a least-privilege
token that lives in your stack's state and is torn down on `destroy` — is
the simplest path.

## Group pipelines under a namespace

Pass an `AiSearchNamespace` resource as `namespace` to group related
pipelines under it instead of the account-provided `default` namespace.

```typescript
const Knowledge = Cloudflare.AiSearchNamespace("Knowledge", {});

export const Search = Cloudflare.AiSearch("Search", {
  source: Docs,
  namespace: Knowledge,
});
```

Passing the namespace resource (not its name) lets the engine order the
pipeline after the namespace on deploy and tear it down before the
namespace on destroy. The namespace is immutable — changing it replaces
the pipeline.

## Add both to the stack

```diff lang="typescript"
// alchemy.run.ts
+import { Docs } from "./src/Docs.ts";
+import { Search } from "./src/Search.ts";
 import Api from "./src/Api.ts";

 export default Alchemy.Stack(
   "CloudflareWorkerExample",
   { providers: Cloudflare.providers(), state: Cloudflare.state() },
   Effect.gen(function* () {
     const api = yield* Api;
+    const docs = yield* Docs;
+    const search = yield* Search;

     return {
       url: api.url.as<string>(),
+      bucket: docs.bucketName,
+      search: search.instanceId,
     };
   }),
 );
```

`yield* Search` registers the construct — the bucket, both tokens, and
the instance all get created on the next deploy, in dependency order.
The value is the `AiSearchInstance` itself, so `search.instanceId` reads
straight off it.

## Bind the instance into the Worker

`Cloudflare.AiSearchInstance.bind(search)` attaches the
single-instance `ai_search` binding and returns a typed Effect client.
Bind it during the Worker's init phase.

```diff lang="typescript"
// src/Api.ts
 import * as Cloudflare from "alchemy/Cloudflare";
 import * as Effect from "effect/Effect";
+import { Search } from "./Search.ts";

 export default class Api extends Cloudflare.Worker<Api>()(
   "Api",
   { main: import.meta.filename },
   Effect.gen(function* () {
+    const aiSearch = yield* Search;
+    const search = yield* Cloudflare.AiSearchInstance.bind(aiSearch);

     return {
       fetch: Effect.gen(function* () {
         // …existing routes
       }),
     };
-  }),
+  }).pipe(Effect.provide(Cloudflare.AiSearchInstanceBindingLive)),
 ) {}
```

`Cloudflare.AiSearchInstanceBindingLive` is the runtime side of the
binding. Provide it once at the bottom of the Init layer chain and the
`bind(...)` above resolves to a live `AiSearchInstance` handle at runtime.

## Answer questions on `/ask`

`search.chatCompletions({ messages })` runs the full RAG pipeline —
retrieve the relevant chunks, then answer with the configured generation
model. It returns an Effect, so call it like any other.

```diff lang="typescript"
+import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
+import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

   return {
     fetch: Effect.gen(function* () {
       const request = yield* HttpServerRequest;
+      const url = new URL(request.url, "http://api");

+      if (url.pathname === "/ask") {
+        const query = url.searchParams.get("q") ?? "What is this about?";
+        const answer = yield* search
+          .chatCompletions({ messages: [{ role: "user", content: query }] })
+          .pipe(Effect.orDie);
+        return yield* HttpServerResponse.json({
+          response: answer.choices[0]?.message.content,
+          sources: answer.chunks.map((c) => c.item.key),
+        });
+      }

       return HttpServerResponse.text("Not Found", { status: 404 });
     }),
   };
```

`answer.choices[0].message.content` is the generated text; `answer.chunks`
are the source chunks it drew from, so we surface their item keys as
citations. `Effect.orDie` turns an `AiSearchError` into a 500 — swap in
`Effect.catchTag("AiSearchError", …)` if you want typed handling.

## Retrieve chunks without generation on `/search`

When you only want the matching chunks (e.g. to render your own UI or
feed another model), use `search.search({ query })` — same retrieval,
no generation step, so it's cheaper and faster.

```diff lang="typescript"
+      if (url.pathname === "/search") {
+        const query = url.searchParams.get("q") ?? "";
+        const hits = yield* search.search({ query }).pipe(Effect.orDie);
+        return yield* HttpServerResponse.json(hits.chunks);
+      }
```

`hits.chunks` is the ranked list of chunks with their scores and source
metadata — no generated answer, because nothing was generated.

## Try it

Deploy, upload a document to the bucket, and ask a question.

```sh
bun alchemy deploy

# upload a doc into the indexed bucket (via wrangler)
echo "Alchemy deploys with 'bun alchemy deploy'." > faq.txt
bunx wrangler r2 object put "$(bun alchemy stack output bucket)/faq.txt" --file faq.txt --remote

# ask over it
curl "$(bun alchemy stack output url)/ask?q=How%20do%20I%20deploy%3F"
```

You can also drag files straight into the bucket from the Cloudflare
dashboard → **R2** → your bucket — anything in there gets indexed.

Indexing is asynchronous — a freshly uploaded file takes a short while
to appear in results. Open the Cloudflare dashboard → **AI** →
**AI Search** → your instance to watch the sync status and confirm the
document was indexed before querying.

## Drop down to the low-level resources

The `AiSearch` helper is the fast path for the common R2 case. Reach
for the underlying resources directly when you need to:

- **share one token across many instances** — create the
  `AiSearchToken` once and pass its `id` as `tokenId` to each
  `AiSearchInstance`,
- **adopt an existing instance or token** rather than create one.

Everything the helper does is just these resources composed — there's
no behavior you lose by dropping down.

## What you have now

- An R2 bucket whose contents are indexed for retrieval.
- A managed, least-privilege API token + AI Search service token, both
  owned by your stack and torn down on `destroy`.
- An `AiSearchInstance` bound into your Worker as a typed Effect client.
- `/ask` (full RAG) and `/search` (retrieval only) routes over your own
  documents.

For the full prop surface — embedding/generation models, R2 prefix and
include/exclude filters, reranking, query rewriting, and similarity
caching — see the [AI Search resource reference](/providers/cloudflare/aisearch/aisearch).
