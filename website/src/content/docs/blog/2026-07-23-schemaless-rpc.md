---
title: Typed RPC without schemas
date: 2026-07-23
draft: true
excerpt: Add `greet: (name) => Effect.succeed(...)` to a Worker, Durable Object, Container, or MicroVM, and every caller instantly has a typed method — the declaration is the contract. Tagged errors survive the wire for Effect.catchTag, and Streams are pulled lazily under backpressure across it.
---

<!-- VIDEO EMBED: schemaless-rpc -->

Every runtime Alchemy deploys — a Cloudflare Worker, a Durable
Object, a Container, an AWS Firecracker MicroVM — returns the
same interface: `{ fetch, ...rpcs }`. Any function member
returning an Effect or a Stream becomes a remotely callable,
typed method:

```typescript
greet: (name: string) => Effect.succeed(`hello ${name}`),
```

Bind the class from another resource and the method is there,
typed, on all four pairings:

```typescript
// Worker → Worker — a service binding stub
const target = yield* Cloudflare.Workers.bindWorker(Greeter);
const greeting = yield* target.greet(name);

// Worker → Durable Object — a stub per named instance
const next = yield* counters.getByName(name).increment();

// Durable Object → Container — fetch transport into the container
const pong = yield* container.ping();

// Lambda → Firecracker MicroVM — connect across the network
const sandbox = yield* AWS.Lambda.connectMicrovm(Sandbox, {
  endpoint: vm.endpoint,
  authToken,
});
const reply = yield* sandbox.hello(message);
```

One contract, four runtimes. It's why the Durable Object
counter, the container sandbox, and the microVM sandbox all
look identical once you've seen one of them.

## The declaration is the contract

Here is a complete RPC server. The `greet` method is the entire
API surface — its declaration is everything a caller needs:

```typescript
export default class Greeter extends Cloudflare.Worker<Greeter>()(
  "Greeter",
  { main: import.meta.url },
  Effect.gen(function* () {
    return {
      greet: (name: string) => Effect.succeed(`hello ${name}`),
      fetch: Effect.gen(function* () {
        return HttpServerResponse.text("ok");
      }),
    };
  }),
) {}
```

There is no schema because the class itself carries the type:
`class Greeter extends Cloudflare.Worker<Greeter>()(...)` makes
the class's instance type exactly the Shape its init Effect
returns, and binding the class produces the client:

```typescript
// in another Worker's init phase:
const target = yield* Cloudflare.Workers.bindWorker(Greeter);

// in its fetch handler:
const greeting = yield* target.greet(name); // typed from Greeter's Shape
```

The stub is a Proxy whose get-trap dispatches over the wire —
every property access is a remote call. One wire protocol, two
carriers: where the platform provides a native structured-clone
channel (Cloudflare service bindings and Durable Object stubs),
calls ride it directly. Everywhere else — Containers and
MicroVMs — a generic fetch transport carries the call as a
`POST {base}/__rpc__/{name}` with a JSON argument array.
Per-call protocol overhead is sub-millisecond, benchmarked in
the wire-protocol test suite. The full mechanism is documented
at [Schemaless RPC](/apis/schemaless).

## Errors that survive the wire

Typed failures cross the boundary intact. Fail with a tagged
error on the callee:

```typescript
class KeyMissing extends Data.TaggedError("KeyMissing")<{
  readonly key: string;
}> {}

// callee — a method that fails with a tagged error:
get: (key: string) =>
  kv.get(key).pipe(
    Effect.flatMap((value) =>
      value === null
        ? Effect.fail(new KeyMissing({ key }))
        : Effect.succeed(value),
    ),
  ),
```

…and recover it on the caller, in another process, on another
machine:

```typescript
const value = yield* stub.get(key).pipe(
  Effect.catchTag("KeyMissing", (e) =>
    Effect.succeed(`missing: ${e.key}`),
  ),
);
```

The codec rules are simple: tagged errors keep `_tag` and all
own enumerable fields, and arrive as plain structs.
`Effect.catchTag` matches because it keys on `_tag` — but
`e instanceof KeyMissing` is `false`; class identity does not
survive the hop. After the `catchTag`, the compiler knows
`KeyMissing` is gone from the error channel — error handling
across a network boundary, checked like a local call.

## Streams under backpressure

A method can return a Stream, and the stub call's return value
is *both* an Effect and a Stream — value methods `yield*`,
streaming methods pipe:

```typescript
// one stub, both call shapes:
const greeting = stub.greet(name);                   // value method — yield* it as an Effect
const firstFive = stub.tick(n).pipe(Stream.take(5)); // streaming method — pipe it as a Stream
```

Streams are pulled lazily under backpressure: an infinite
remote Stream can be `Stream.take(5)`-ed, and the server stops
producing when the client stops consuming. On the native
channel elements move by structured clone; on the fetch
transport they arrive as NDJSON, flagged by a response header.
Byte streams (`Uint8Array`) round-trip alongside JSON object
streams, and a failure mid-stream travels as a trailing error
marker — values emitted before the failure are still delivered.

A returned Stream pipes through any `Stream.*` combinator,
including straight onto an HTTP response:

```typescript
const stream = counters.getByName("tick").tick(n).pipe(
  Stream.map((i) => `${i}\n`),
  Stream.encodeText,
);
return HttpServerResponse.stream(stream, {
  headers: { "content-type": "text/plain" },
});
```

The Durable Object produces values lazily, the runtime ferries
each chunk to the Worker, and the Worker flushes them onto the
response — type-checked end-to-end. The full walkthrough is in
[Durable Objects](/cloudflare/compute/durable-objects#stream-rpc-return-values).

## Refactoring across a network boundary

The types flow from the implementation: add a method, and every
caller sees it immediately; change a return type, and every
caller that mismatches fails to compile. Refactor the server:

```diff lang="typescript"
    return {
-      greet: (name: string) => Effect.succeed(`hello ${name}`),
+      greet: (name: string) =>
+        Effect.succeed({ message: `hello ${name}` }),
      fetch: Effect.gen(function* () {
        return HttpServerResponse.text("ok");
      }),
    };
```

…and the call site — in a different Worker, deployed as a
different script — turns red:

```typescript
const greeting = yield* target.greet(name);
return HttpServerResponse.text(greeting);
//                             ~~~~~~~~
// Type '{ message: string }' is not assignable to type 'string'
```

A cross-network refactor, caught by `tsc` before anything
deploys. This is the property the
[Durable Objects guide](/cloudflare/compute/durable-objects#schemaless-rpc)
leans on: the stub mirrors the implementation's signatures
exactly, so the compiler checks both sides of the wire from one
source of truth.

## What the types reject

The contract is enforced at declaration, not at call time. A
member that is a plain value, or a function returning a plain
value, fails the Shape constraint:

```typescript
// ❌ rejected — neither member is an Effect, a Stream, or returns one:
return {
  version: "1.0",
  greet: (name: string) => `hello ${name}`,
};

// ✅ accepted:
return {
  version: () => Effect.succeed("1.0"),
  greet: (name: string) => Effect.succeed(`hello ${name}`),
};
```

The rejection surfaces as an assignability error on the init
Effect you pass to the host class — so a shape that compiles is
a shape every caller can rely on.

The rest of the limits, stated plainly: arguments and results
must survive the wire codec — structured clone on the native
channel, JSON on the fetch transport. Stream elements must be
JSON values or `Uint8Array`. Functions and callbacks don't
serialize. Class identity is always stripped. And because every
property access on a stub dispatches remotely, the stub is only
its methods — there are no local fields.

There is zero runtime validation anywhere in the stub or the
server. That is the point — and the trade-off: nothing
sanitizes what arrives. Both sides are your code, deployed
together and typed from the same Shape, which is why the trade
is safe internally. At a trust boundary — external callers,
versioned APIs, untrusted input — reach for schema-validated
[Effect RPC](/apis/effect-rpc) instead.

## Where to go next

- [Schemaless RPC](/apis/schemaless) — the pattern: allowed members, the typed client, transports, streams, errors, limits
- [Schemaless RPC on Cloudflare](/cloudflare/apis/schemaless-rpc) — every pairing: Worker → Worker, Worker → DO, another script's DO, Containers
- [Schemaless RPC on AWS](/aws/apis/schemaless-rpc) — Lambda → Firecracker MicroVM over the fetch transport
- [Durable Objects](/cloudflare/compute/durable-objects) — build the stateful counter and stream out of it
- [MicroVMs](/aws/compute/microvms) — build images and drive instances with typed lifecycle bindings
- [Effect RPC](/apis/effect-rpc) — schema-validated RPC for trust boundaries

Alchemy is in beta — APIs may still shift between releases:

```sh
bun add alchemy@next
```
