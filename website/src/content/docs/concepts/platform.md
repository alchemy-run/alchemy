---
title: Platform
description: How Alchemy deploys Workers, Durable Objects, Containers, and Lambda Functions — Effect and Async styles.
sidebar:
  order: 2
---

A **Platform** is a compute target that runs your code — a Cloudflare
Worker, a Durable Object, a Container, or an AWS Lambda Function.
Every Platform follows a two-phase pattern in Effect programs:

```typescript
Effect.gen(function* () {
  // Phase 1 (deploy time): bind resources, resolve dependencies
  const kv = yield* Cloudflare.KVNamespace.bind(MyKV);

  return {
    // Phase 2 (runtime): handlers that run on each request
    fetch: Effect.gen(function* () {
      const value = yield* kv.get("key");
      return HttpServerResponse.text(value ?? "not found");
    }),
  };
});
```

There are two ways to define a Platform resource. See
[Effect vs Async](/concepts/effect-vs-async) for the full mental model.

## Async

Write a plain `async` handler and let Alchemy provision and deploy it.
Your runtime code is vanilla TypeScript — no Effect runtime is included
in the bundle. You still get full IaC for resource provisioning.

```typescript
// alchemy.run.ts
export const Worker = Cloudflare.Worker("Worker", {
  main: "./src/worker.ts",
  bindings: { DB, Bucket },
});
```

```typescript
// src/worker.ts
export default {
  async fetch(request: Request, env: WorkerEnv) {
    const object = await env.Bucket.get(url.pathname);
    return new Response(object?.body ?? null);
  },
};
```

The same pattern works for AWS Lambda — yield a `Function` resource with
`main` pointing at a plain handler file and no Effect implementation.

See the [Async Worker](/guides/async/worker) and
[Async Lambda Function](/guides/async/lambda-function) guides.

## Effect

Pass an `Effect.gen` implementation when defining the class. Alchemy
wires the full Effect runtime into the bundle, including Layers,
ConfigProvider, logging, and platform services.

```typescript
export default class Api extends Cloudflare.Worker<Api>()(
  "Api",
  { main: import.meta.path },
  Effect.gen(function* () {
    const kv = yield* Cloudflare.KVNamespace.bind(MyKV);

    return {
      fetch: Effect.gen(function* () {
        const value = yield* kv.get("key");
        return HttpServerResponse.text(value ?? "not found");
      }),
    };
  }),
) {}
```

For Workers that need to be imported by other Workers without pulling
in runtime code, use the Tag/Layer split with `.make()`. See the
[Dynamic Workers](/guides/effect/dynamic-workers) guide for the full pattern.

See the [Effect Worker](/guides/effect/worker),
[Durable Object](/guides/effect/durable-object),
[Container](/guides/effect/container), and
[Lambda Function](/guides/effect/lambda-function) guides.

## When to Use Which

| Scenario                              | Style  |
| ------------------------------------- | ------ |
| Plain async handler, no Effect        | Async  |
| Quick prototype or script             | Effect |
| Standalone Worker or Lambda           | Effect |
| Typed bindings with automatic IAM     | Effect |
| Event sources, sinks, streaming       | Effect |
| Bi-directional Worker RPC             | Effect |
| Container (always separate process)   | Effect |
