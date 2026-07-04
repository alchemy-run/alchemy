---
title: Durable Objects and Containers as Effect programs
date: 2026-07-28
draft: true
excerpt: A stateful counter where the class is both the infrastructure declaration and the typed client. A container sandbox whose Dockerfile is one inline line. And two Workers that call each other — a reference cycle alchemy plans and deploys.
---

<!-- VIDEO EMBED: durable-objects-and-containers -->

Three requests against a deployed Worker:

```sh
❯ curl -X POST https://my-app.sam.workers.dev/counter/foo
1
❯ curl -X POST https://my-app.sam.workers.dev/counter/foo
2
❯ curl -X POST https://my-app.sam.workers.dev/counter/bar
1
```

`foo` and `bar` each landed on their own globally-unique, stateful
instance with its own transactional storage. Here is everything
that implements it — one class, about twenty lines:

```typescript
// src/counter.ts
import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";

export default class Counter extends Cloudflare.DurableObject<Counter>()(
  "Counter",
  Effect.gen(function* () {
    const state = yield* Cloudflare.DurableObjectState;
    return Effect.gen(function* () {
      let count = (yield* state.storage.get<number>("count")) ?? 0;
      return {
        increment: () =>
          Effect.gen(function* () {
            count += 1;
            yield* state.storage.put("count", count);
            return count;
          }),
        get: () => Effect.succeed(count),
      };
    });
  }),
) {}
```

The outer `Effect.gen` is the instance's init phase — it resolves
`DurableObjectState`, the per-instance handle for storage, alarms,
and WebSockets. The inner one returns the public API, and any
function that returns an `Effect` becomes a typed RPC method.

## The class is the infrastructure and the client

Yield the class inside a Worker's init phase and you get a
namespace handle. That single `yield*` registers the DO with the
Worker — the binding plus the class-migration metadata — and hands
back the typed namespace:

```diff lang="typescript"
// src/worker.ts
+import Counter from "./counter.ts";

  Effect.gen(function* () {
+    const counters = yield* Counter;

    return {
      fetch: Effect.gen(function* () {
        return HttpServerResponse.text("Hello from my Worker!");
      }),
    };
  }),
```

`counters.getByName(name)` returns a typed stub that mirrors the
implementation exactly — the Worker sees `increment(): Effect<number>`
and `get(): Effect<number>` as you defined them:

```diff lang="typescript"
  fetch: Effect.gen(function* () {
+    const request = yield* HttpServerRequest;
+
+    if (request.url.startsWith("/counter/") && request.method === "POST") {
+      const name = request.url.split("/").pop()!;
+      const next = yield* counters.getByName(name).increment();
+      return HttpServerResponse.text(String(next));
+    }
+
    return HttpServerResponse.text("Hello from my Worker!");
  }),
```

Deploy plans a Worker update and a new `Counter` namespace:

```sh
bun alchemy deploy
```

That's the whole loop: the class declares the infrastructure, the
`yield*` wires the binding, and the stub is the client. Add a
method and every caller sees it immediately; change a return type
and every mismatched caller fails to compile. The full walkthrough
is in [Durable Objects](/cloudflare/compute/durable-objects), and the
mechanism behind the stub is [Schemaless RPC](/apis/schemaless).

## Streaming out of a DO

RPC methods can return a `Stream` too. `tick(n)` emits `n` numbers
100ms apart:

```diff lang="typescript"
// src/counter.ts
      return {
        increment: () => /* ... */,
        get: () => Effect.succeed(count),
+        tick: (n: number) =>
+          Stream.iterate(0, (i) => i + 1).pipe(
+            Stream.take(n),
+            Stream.schedule(Schedule.spaced("100 millis")),
+          ),
      };
```

The Worker pipes it straight onto the HTTP response, flushing each
chunk as it arrives:

```diff lang="typescript"
// src/worker.ts
+    if (request.url.startsWith("/tick/") && request.method === "GET") {
+      const n = Number(request.url.split("/").pop()!);
+      const stream = counters.getByName("tick").tick(n).pipe(
+        Stream.map((i) => `${i}\n`),
+        Stream.encodeText,
+      );
+      return HttpServerResponse.stream(stream, {
+        headers: { "content-type": "text/plain" },
+      });
+    }
```

`curl` the route and the numbers arrive live, one line every 100ms.
The DO produces values lazily, the runtime ferries each chunk back
to the Worker, and the Worker streams them to the client —
type-checked end-to-end across all three hops
([Stream RPC return values](/cloudflare/compute/durable-objects#stream-rpc-return-values)).

## A container in fifteen lines

Sometimes a Worker isn't enough — you need a real OS process: a
sandboxed shell, a binary, an HTTP server on a port. A Cloudflare
Container is a long-lived process running beside a Durable Object,
and in alchemy it's the same ceremony: a class with a typed RPC
surface, plus a runtime implementation in its own file:

```typescript
// src/Sandbox.ts
export class Sandbox extends Cloudflare.Container<
  Sandbox,
  { ping: () => Effect.Effect<string> }
>()("Sandbox") {}
```

```typescript
// src/Sandbox.runtime.ts
export default Sandbox.make(
  { main: import.meta.url },
  Effect.gen(function* () {
    return Sandbox.of({
      ping: () => Effect.succeed("pong"),
      fetch: Effect.succeed(
        HttpServerResponse.text("Hello from the container!"),
      ),
    });
  }),
);
```

`main` tells alchemy to bundle this file's Effect program and bake
it into a generated image as the entrypoint. On deploy, alchemy
builds the Docker image, pushes it to Cloudflare's managed
registry, and reconciles the application's scaling and runtime
config — the first deploy takes a minute or two longer while the
registry is provisioned.

A Durable Object owns the container's lifecycle. Yield the class
and provide `Cloudflare.Containers.layer`, which binds, starts, and
monitors the container before handing you a running instance:

```typescript
// src/Agent.ts
export default class Agent extends Cloudflare.DurableObject<Agent>()(
  "Agents",
  Effect.gen(function* () {
    const sandbox = yield* Sandbox;

    return Effect.gen(function* () {
      return {
        ping: () => sandbox.ping(),
      };
    });
  }).pipe(
    Effect.provide(
      Cloudflare.Containers.layer(Sandbox, { enableInternet: true }),
    ),
  ),
) {}
```

A Worker binds `Agent` and calls
`agents.getByName(name).ping()` like any other DO method — the same
typed stub, now reaching a real process. The concepts page is
[Containers](/cloudflare/compute/containers); the full build-out —
a shell-executing sandbox with HTTP proxying, stage-dependent
config, and tests — is [Run a Container](/cloudflare/compute/run-a-container).

## An agent sandbox in one file

The [cloudflare-agent example](https://github.com/alchemy-run/alchemy-effect/tree/main/examples/cloudflare-agent)
puts the pattern to work: `DevBox` is a code-executing sandbox for
an AI agent, and the entire container — image, RPC surface, and
runtime — is one file. The Dockerfile is a single inline line:

```typescript
// src/DevBox.ts
export class DevBox extends Cloudflare.Container<
  DevBox,
  {
    readFile: (path: string) => Effect.Effect<string>;
    writeFile: (path: string, contents: string) => Effect.Effect<void>;
    exec: (command: string) => Effect.Effect<{
      exitCode: number;
      stdout: string;
      stderr: string;
    }>;
  }
>()("DevBox") {}

export default DevBox.make(
  {
    main: import.meta.url,
    dockerfile: `FROM oven/bun:1.3`,
  },
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const cp = yield* ChildProcessSpawner;

    return {
      readFile: (path: string) => fs.readFileString(path).pipe(Effect.orDie),
      writeFile: (path: string, contents: string) =>
        fs.writeFileString(path, contents).pipe(Effect.orDie),
      exec: (command: string) =>
        cp.spawn(ChildProcess.make(command, { shell: true })).pipe(
          Effect.flatMap(({ exitCode, stdout, stderr }) =>
            Effect.all({
              exitCode,
              stdout: stdout.pipe(Stream.decodeText, Stream.mkString),
              stderr: stderr.pipe(Stream.decodeText, Stream.mkString),
            }),
          ),
          Effect.scoped,
          Effect.orDie,
        ),
    };
  }),
);
```

In the example, an agent's `writeFile` tool is a `Layer` over the
container's typed RPC — the agent drafts release blog posts and
writes them into its sandbox through the same stub any Worker
would use:

```typescript
export const WriteFileDevBox = Layer.effect(
  WriteFile,
  Effect.gen(function* () {
    const devBox = yield* DevBox;

    return ({ path, contents }) => devBox.writeFile(path, contents);
  }),
);
```

A shell, a filesystem, and a typed client for both — declared,
implemented, and deployed from one TypeScript file.

## The cycle that deploys

Real systems have cycles: a web Worker calls an internal Worker for
auth; the internal Worker calls back for billing. At deploy time
that's a chicken-and-egg — neither Worker can be created first,
because each needs the other's URL.

Alchemy resolves it by separating **identity** from
**implementation**. The class is a Tag — importing it across the
cycle is cheap and side-effect free — and the runtime attaches via
`.make()`:

```typescript
// src/A.ts
export class A extends Cloudflare.Worker<A, { work: () => Effect.Effect<string> }>()("A") {}

export default A.make(
  { main: import.meta.url },
  Effect.gen(function* () {
    const b = yield* Cloudflare.Workers.bindWorker(B);
    return {
      fetch: Effect.gen(function* () {
        // delegate half the work to B over the RPC stub
        return HttpServerResponse.text(yield* b.work());
      }),
      work: () => Effect.succeed("A handled its half"),
    };
  }),
);
```

`B.ts` is the mirror image — it imports `A`'s Tag and binds it. The
engine plans the cycle in two passes: each provider's `precreate`
hook reserves the resource and its URL up front, `create` runs in
parallel against deferred typed Outputs, and a converge pass wires
the real cross-references once both sides exist.

The step-by-step guide is
[Circular Bindings](/infrastructure-as-effects/circular-bindings), and the
engine-level story — how the plan graph and the type system both
handle cycles — is in the companion deep-dive published today:
[Circular references, without the deadlock](/blog/2026-04-25-circular-references).

## Where to go next

- [Durable Objects](/cloudflare/compute/durable-objects) — the counter, streaming, and schemaless RPC, step by step
- [Containers](/cloudflare/compute/containers) and [Run a Container](/cloudflare/compute/run-a-container) — from `ping()` to a shell-executing sandbox with tests
- [Accept WebSockets](/cloudflare/compute/hibernatable-websockets) — connections that survive hibernation
- [Bind to another Worker's Durable Object](/cloudflare/compute/cross-worker-durable-object) — one Worker hosts the DO, others get the typed stub
- [Circular Bindings](/infrastructure-as-effects/circular-bindings) — the Worker↔Worker cycle in full
- [examples/cloudflare-agent](https://github.com/alchemy-run/alchemy-effect/tree/main/examples/cloudflare-agent) — the DevBox agent sandbox

Alchemy is in beta — install it with:

```sh
bun add alchemy@next
```
