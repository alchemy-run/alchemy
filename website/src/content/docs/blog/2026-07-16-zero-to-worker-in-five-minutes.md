---
title: "Zero → production: a typed Cloudflare Worker in five minutes"
date: 2026-07-16
draft: true
excerpt: From an empty directory to a deployed Worker reading R2 with typed errors — the whole path in one sitting. In Effect style or plain async/await — same infrastructure declarations, same CLI.
---

<!-- VIDEO EMBED: zero-to-worker-in-five-minutes -->

```sh
curl https://myapp-worker-dev-you-abc123.workers.dev/hello.txt
# → Hello, world!
```

That response comes from a deployed Cloudflare Worker reading an
R2 bucket it is typed against, end to end. A few minutes earlier
the project was an empty directory. Here is the whole path — the
granular step-by-step lives in
[Part 1](/cloudflare/tutorial/part-1) and
[Part 2](/cloudflare/tutorial/part-2) of the Cloudflare tutorial.

## The first stack

Start from nothing:

```sh
mkdir my-app && cd my-app && bun init -y
bun add alchemy@next effect @effect/platform-bun @effect/platform-node
```

Every Alchemy program starts with a `Stack` — resources declared
in real TypeScript, deployed with state tracked between runs:

```typescript
// alchemy.run.ts
import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

export default Alchemy.Stack(
  "MyApp",
  {
    providers: Layer.empty,
    state: Cloudflare.state(),
  },
  Effect.gen(function* () {
    const bucket = yield* Cloudflare.R2.Bucket("Bucket");

    return { bucketName: bucket.bucketName };
  }),
);
```

The tutorial walks you into a compile error here on purpose:
`Layer.empty` doesn't provide `Cloudflare.Providers`, the layer
`Bucket` requires — and TypeScript says so, naming the missing
layer, before anything touches the network. The fix is one line:

```diff lang="typescript"
-    providers: Layer.empty,
+    providers: Cloudflare.providers(),
```

The providers layer tells Alchemy how to talk to Cloudflare's
APIs, and the type system ensures you never forget to wire it up.
Now deploy:

```sh
bun alchemy deploy
```

```
Plan: 1 to create
+ Bucket (Cloudflare.R2.Bucket)

Proceed? Yes

✓ Bucket (Cloudflare.R2.Bucket) created
{
  bucketName: "myapp-bucket-a1b2c3d4e5",
}
```

The first run handles everything interactively: a browser login
saved to your [profile](/environments/profiles), and a one-time
bootstrap of the [state store](/state-store) into your Cloudflare
account. Part 1 of the tutorial covers this milestone — install to
live bucket — and its own claim is "all in under five minutes."
The timer in the video holds it to that.

## A Worker that binds the bucket

Resource declarations are just descriptions — they don't execute
until you `yield*` them inside a Stack — so give the bucket its
own file and import it from anywhere:

```typescript
// src/bucket.ts
import * as Cloudflare from "alchemy/Cloudflare";

export const Bucket = Cloudflare.R2.Bucket("Bucket");
```

A Worker is a resource that carries its runtime code inside it.
The outer generator runs at plan time and at startup; the inner
`fetch` runs per request:

```typescript
// src/worker.ts
import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import { Bucket } from "./bucket.ts";

export default Cloudflare.Worker(
  "Worker",
  { main: import.meta.url },
  Effect.gen(function* () {
    const bucket = yield* Cloudflare.R2.ReadWriteBucket(Bucket);

    return {
      fetch: Effect.gen(function* () {
        return HttpServerResponse.text("Hello, world!");
      }),
    };
  }).pipe(Effect.provide(Cloudflare.R2.ReadWriteBucketBinding)),
);
```

The line to stare at is
`yield* Cloudflare.R2.ReadWriteBucket(Bucket)`. It carries the
deploy-time binding — Alchemy attaches the native R2 binding to
the Worker when it ships — and it returns the typed runtime
client you call as `bucket`. One line: config, permission, and
client. The `ReadWriteBucketBinding` layer on the end teaches the
Worker runtime how to resolve that binding from the Cloudflare
environment.

Wire the Worker into the Stack and expose its URL:

```diff lang="typescript"
// alchemy.run.ts
import { Bucket } from "./src/bucket.ts";
+import Worker from "./src/worker.ts";

  Effect.gen(function* () {
    const bucket = yield* Bucket;
+   const worker = yield* Worker;

    return {
      bucketName: bucket.bucketName,
+     url: worker.url,
    };
  }),
```

`bun alchemy deploy` again — the plan shows one Worker to create,
the Bucket unchanged — and the stack prints a live URL:

```
✓ Worker (Cloudflare.Worker) created
{
  bucketName: "myapp-bucket-a1b2c3d4e5",
  url: "https://myapp-worker-dev-you-abc123.workers.dev",
}
```

## When the bucket says no

Add a PUT route that streams the request body into the bucket:

```diff lang="typescript"
      fetch: Effect.gen(function* () {
+       const request = yield* HttpServerRequest;
+       const key = request.url.split("/").pop()!;
+
+       if (request.method === "PUT") {
+         yield* bucket.put(key, request.stream, {
+           contentLength: Number(request.headers["content-length"] ?? 0),
+         });
+         return HttpServerResponse.empty({ status: 201 });
+       }

        return HttpServerResponse.text("Hello, world!");
      }),
```

TypeScript flags it immediately: `bucket.put` can fail with
`R2Error`, but a Worker's `fetch` handler only allows
`HttpServerError` or `HttpBodyError`. R2 operations carry a typed
`R2Error` the compiler forces you to handle — the runtime failure
mode is part of the function's type. Handle it:

```diff lang="typescript"
        return HttpServerResponse.text("Hello, world!");
-     }),
+     }).pipe(
+       Effect.catchTag("R2Error", (error) =>
+         Effect.succeed(
+           HttpServerResponse.text(error.message, { status: 500 }),
+         ),
+       ),
+     ),
```

The type error disappears because `R2Error` is now fully handled
— the error channel is provably empty again. If an R2 operation
fails at runtime, the Worker returns a 500 instead of crashing.

A missing key is a different thing entirely: it's a value, not an
error. `bucket.get` returns `null`, and you handle it with an
ordinary branch:

```diff lang="typescript"
+       const object = yield* bucket.get(key);
+       if (object === null) {
+         return HttpServerResponse.text("Not found", { status: 404 });
+       }
+       const text = yield* object.text();
+       return HttpServerResponse.text(text);
-       return HttpServerResponse.text("Hello, world!");
```

`bucket.get` can also fail with `R2Error`, and the `catchTag` you
already wrote covers it. Deploy and hit it:

```sh
# Store an object
curl -X PUT https://myapp-worker-dev-you-abc123.workers.dev/hello.txt \
  -d 'Hello, world!'

# Retrieve it
curl https://myapp-worker-dev-you-abc123.workers.dev/hello.txt
# → Hello, world!
```

Which is where the cold open came from.

## The same app in async/await

Everything above also works as a standard `async fetch` handler.
Pass the bucket as `env` in the stack file and derive the env
type with `InferEnv`:

```typescript
// alchemy.run.ts
export type WorkerEnv = Cloudflare.InferEnv<typeof Worker>;

export const Worker = Cloudflare.Worker("Worker", {
  main: "./src/worker.ts",
  env: { Bucket },
});
```

```typescript
// src/worker.ts
import type { WorkerEnv } from "../alchemy.run.ts";

export default {
  async fetch(request: Request, env: WorkerEnv) {
    const object = await env.Bucket.get("key");
    return new Response(object?.body ?? null);
  },
};
```

`env.Bucket` autocompletes as a fully typed R2 bucket, inferred
straight from the stack declaration — add a Queue or a Durable
Object to `env` and the handler's type updates with it. Both
styles use the same infrastructure declarations, the same CLI,
and the same deployment pipeline
([Two styles](/what-is-alchemy#two-styles-effect-and-async)).

The shipped
[cloudflare-worker-async](https://github.com/alchemy-run/alchemy-effect/tree/main/examples/cloudflare-worker-async)
example runs this style at full scale — D1, R2, a Queue producer
*and* consumer, and a Durable Object, all through one typed `env`
— and
[cloudflare-dev](https://github.com/alchemy-run/alchemy-effect/tree/main/examples/cloudflare-dev)
runs an Effect Worker and an async Worker side by side in a
single stack.

## Where to go next

The stack you just built is the exact one the rest of the series
grows: tests deploy it, dev mode hot-reloads it, and CI later
deploys it per pull request — same code, every stage.

- [Part 3: Testing](/cloudflare/tutorial/part-3) — integration
  tests that deploy the stack and assert over live HTTP
- [Part 4: Local Dev](/cloudflare/tutorial/part-4) — `alchemy dev`
  hot reloading against real cloud resources
- [Part 5: CI/CD](/cloudflare/tutorial/part-5) — PR previews and
  credentials managed as code
- [What is Alchemy?](/what-is-alchemy) — the concepts behind all
  of it

Alchemy is in beta — expect sharp edges, and file issues when you
hit them:

```sh
bun add alchemy@next
```
