---
title: "Infrastructure as Effects: your app and its cloud in one program"
date: 2026-07-14
draft: true
excerpt: A Worker that reads from an R2 bucket needs three things — the bucket, the permission to read it, and a client to read it with. Alchemy makes them one type-checked TypeScript program. The binding is the client, and the compiler catches your wiring mistakes before anything deploys.
---

<!-- VIDEO EMBED: infrastructure-as-effects -->

A Cloudflare Worker that reads from an R2 bucket needs three
things: the bucket, the permission to read it, and a client to
read it with. Here they are — all of them:

```typescript
// src/bucket.ts
import * as Cloudflare from "alchemy/Cloudflare";

export const Bucket = Cloudflare.R2.Bucket("Bucket");
```

```typescript
// src/worker.ts
import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import { Bucket } from "./bucket.ts";

export default Cloudflare.Worker(
  "Worker",
  { main: import.meta.url },
  Effect.gen(function* () {
    const bucket = yield* Cloudflare.R2.ReadWriteBucket(Bucket);
    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const key = request.url.split("/").pop()!;

        if (request.method === "PUT") {
          yield* bucket.put(key, request.stream, {
            contentLength: Number(request.headers["content-length"] ?? 0),
          });
          return HttpServerResponse.empty({ status: 201 });
        }

        const object = yield* bucket.get(key);
        if (object === null) {
          return HttpServerResponse.text("Not found", { status: 404 });
        }
        const text = yield* object.text();
        return HttpServerResponse.text(text);
      }).pipe(
        Effect.catchTag("R2Error", (error) =>
          Effect.succeed(
            HttpServerResponse.text(error.message, { status: 500 }),
          ),
        ),
      ),
    };
  }).pipe(Effect.provide(Cloudflare.R2.ReadWriteBucketBinding)),
);
```

```typescript
// alchemy.run.ts
import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import { Bucket } from "./src/bucket.ts";
import Worker from "./src/worker.ts";

export default Alchemy.Stack(
  "MyApp",
  {
    providers: Cloudflare.providers(),
    state: Cloudflare.state(),
  },
  Effect.gen(function* () {
    const bucket = yield* Bucket;
    const worker = yield* Worker;

    return { url: worker.url };
  }),
);
```

That's the entire project. The bucket is a value the Worker
imports, the Worker binds it in one line, and the Stack is a
TypeScript program that deploys both. The infrastructure, the
runtime code, and the wiring between them live in the same
type-checked program.

## Deploy it

```sh
bun alchemy deploy
```

```
Plan: 2 to create

+ Bucket  (Cloudflare.R2.Bucket)
+ Worker  (Cloudflare.Worker)  (1 bindings)

✓ Bucket  (Cloudflare.R2.Bucket)  created
✓ Worker  (Cloudflare.Worker)     created
{
  url: "https://myapp-worker-dev-you-abc123.workers.dev",
}
```

Alchemy plans the change, shows you the diff, and converges the
cloud to what the program declares — create, update, replace,
and delete all resolve through the same
[resource lifecycle](/infrastructure-as-code/resource-lifecycle).
(How a single `reconcile` function replaces create-vs-update is
its own story:
[One reconcile, no create vs. update](/blog/2026-05-04-reconcile).)

The URL is live:

```sh
curl -X PUT https://myapp-worker-dev-you-abc123.workers.dev/hello.txt \
  -d 'Hello, world!'

curl https://myapp-worker-dev-you-abc123.workers.dev/hello.txt
# → Hello, world!
```

## The binding is the client

The one line worth staring at:

```typescript
const bucket = yield* Cloudflare.R2.ReadWriteBucket(Bucket);
```

That call does two jobs. At deploy time it registers the R2
binding on the Worker — the configuration and the permission
travel with the code that needs them. At runtime it hands you
`bucket`: the resource itself, presented as a typed client.
`bucket.put` and `bucket.get` are fully typed against the real
R2 API, and the same `yield*` that granted the access is the
one that returns the SDK. One line carries the config, the
permissions, and the client.

The errors are part of the contract too. `bucket.put` can fail
with `R2Error`, and a Worker's `fetch` handler admits only
`HttpServerError | HttpBodyError` — so the program above only
compiles because of the `Effect.catchTag("R2Error", ...)` at
the bottom of the handler. Delete that block and the file stops
type-checking: runtime error handling, verified at compile
time. ([Tutorial part 2](/cloudflare/tutorial/part-2) walks
this exact sequence.)

The `Effect.provide(Cloudflare.R2.ReadWriteBucketBinding)` on
the last line is the implementation choice — the contract is
satisfiable by a native workerd binding or by Cloudflare's HTTP
API with a scoped token, swapped with a single `Effect.provide`.
The full mechanics — what one binding call records at deploy
time, and how the same line behaves in each phase — are in
[Bindings](/infrastructure-as-effects/binding) and the deep-dive
[Bindings — one line, two phases](/blog/2026-04-30-bindings).

## The compiler checks the cloud

A Stack is real TypeScript, so wiring mistakes surface where
TypeScript surfaces everything else — in the editor. Give the
Stack an empty providers layer:

```typescript
export default Alchemy.Stack(
  "MyApp",
  {
    providers: Layer.empty,
  },
  Effect.gen(function* () {
    const bucket = yield* Cloudflare.R2.Bucket("Bucket");
  }),
);
```

The compiler rejects it: `Layer.empty` doesn't provide
`Cloudflare.Providers`, the layer `Bucket` requires. The fix is
the wiring itself:

```diff lang="typescript"
-    providers: Layer.empty,
+    providers: Cloudflare.providers(),
```

Every resource's provider requirement flows through the type
system, so the program only compiles when the whole cloud is
wired up — before anything deploys. (See the live error in
[What is Alchemy › Type safety](/what-is-alchemy#type-safety).)

On AWS, the same mechanism yields least-privilege statements
generated from binding calls — each one scoped to the exact
action and resource ARN the client needs:

| Binding                   | IAM Actions        | Resource                     |
| ------------------------- | ------------------ | ---------------------------- |
| `S3.GetObject(bucket)`    | `s3:GetObject`     | `arn:aws:s3:::bucket-name/*` |
| `S3.PutObject(bucket)`    | `s3:PutObject`     | `arn:aws:s3:::bucket-name/*` |
| `SQS.SendMessage(queue)`  | `sqs:SendMessage`  | Queue ARN                    |
| `DynamoDB.GetItem(table)` | `dynamodb:GetItem` | Table ARN                    |

The policy exists because the line does. Remove the binding
call and the statement drops out of the next plan — the
permission set tracks the code that uses it.

## Effect is optional

The same stack works with a plain `async` handler. Attach the
bucket as `env` in the stack file:

```typescript
// alchemy.run.ts — declare resources, attach via env.
export const Bucket = Cloudflare.R2.Bucket("Bucket");

export const Worker = Cloudflare.Worker("Worker", {
  main: "./src/worker.ts",
  env: { Bucket },
});

export type WorkerEnv = Cloudflare.InferEnv<typeof Worker>;
```

```typescript
// src/worker.ts — keep your existing async handler.
import type { WorkerEnv } from "../alchemy.run.ts";

export default {
  async fetch(req: Request, env: WorkerEnv) {
    const obj = await env.Bucket.get("hello.txt");
    return new Response(obj?.body ?? "Not found");
  },
};
```

`Cloudflare.InferEnv<typeof Worker>` derives the `env` type
directly from the stack declaration — `env.Bucket` autocompletes
as a typed R2 bucket the moment you add it to `env`, straight
from the type system. Both styles share the same infrastructure
declarations, the same CLI, and the same deploy pipeline
([What is Alchemy › Two styles](/what-is-alchemy#two-styles-effect-and-async));
[examples/cloudflare-dev](https://github.com/alchemy-run/alchemy-effect/tree/main/examples/cloudflare-dev)
runs an Effect Worker and an async Worker side by side in one
stack. If you're coming from Alchemy v1, the async style is the
familiar shape — see
[Migrating from v1](/migrating-from-v1).

## Tear it down

```sh
bun alchemy destroy
```

```
Plan: 2 to delete

- Worker  (Cloudflare.Worker)
- Bucket  (Cloudflare.R2.Bucket)

✗ Worker  (Cloudflare.Worker)     deleted
✗ Bucket  (Cloudflare.R2.Bucket)  deleted
```

The same engine that stood the stack up unwinds it in reverse
dependency order. Stand up infrastructure. Tear it down just as
fast.

## Where to go next

- [Tutorial part 1](/cloudflare/tutorial/part-1) — from an empty directory to a deployed stack
- [What is Alchemy?](/what-is-alchemy) — the concepts on one page
- [Bindings](/infrastructure-as-effects/binding) — the deploy-time mechanics behind the one-liner
- [Bindings — one line, two phases](/blog/2026-04-30-bindings) — the deep-dive
- [One reconcile, no create vs. update](/blog/2026-05-04-reconcile) — the engine behind the deploy transcript
- [examples/cloudflare-dev](https://github.com/alchemy-run/alchemy-effect/tree/main/examples/cloudflare-dev) — both Worker styles, DOs, a Queue, and a container in one stack

Alchemy is in beta — APIs may still shift between releases:

```sh
bun add alchemy@next
```
