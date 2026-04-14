---
title: Binding
description: How resources are connected at deploy time and used at runtime.
sidebar:
  order: 3
---

A **Binding** connects a resource to a runtime host (Worker, Durable
Object, Lambda Function) so it can be used at runtime. Bindings handle
two things:

1. **Deploy-time** — attach IAM policies, environment variables, or
   Cloudflare bindings to the host
2. **Runtime** — provide a typed SDK wrapper for calling the bound
   resource

## How bindings work

When you call `.bind()` on a resource inside a Worker's init phase,
two things happen behind the scenes:

- A **Binding.Policy** runs at deploy time to configure the host
  (e.g. attach an IAM policy to a Lambda role, or add a binding to a
  Worker's config)
- A **Binding.Service** provides a typed runtime wrapper that you use
  in your request handlers

You don't interact with these directly — `.bind()` handles both.

## Cloudflare bindings

```typescript
// KV
const kv = yield* Cloudflare.KVNamespace.bind(MyKV);
yield* kv.get("key");
yield* kv.put("key", "value");

// R2
const bucket = yield* Cloudflare.R2Bucket.bind(MyBucket);
yield* bucket.get("file.txt");
yield* bucket.put("file.txt", data);

// D1
const db = yield* Cloudflare.D1Connection.bind(MyDB);
yield* db.prepare("SELECT * FROM users").all();

// Durable Object
const counters = yield* Counter;
const counter = counters.getByName("user-123");
yield* counter.increment();

// Worker-to-Worker
const other = yield* Cloudflare.Worker.bind(OtherWorker);
yield* other.someRpcMethod();

// Container
const sandbox = yield* Cloudflare.Container.bind(Sandbox);
const container = yield* Cloudflare.start(sandbox);
yield* container.exec("echo hi");
```

## AWS bindings

```typescript
// S3
const getObject = yield* S3.GetObject.bind(bucket);
const response = yield* getObject({ Key: "hello.txt" });

// DynamoDB
const getItem = yield* DynamoDB.GetItem.bind(table);
const item = yield* getItem({ Key: { pk: { S: "user#123" } } });

// SQS
const sendMessage = yield* SQS.SendMessage.bind(queue);
yield* sendMessage({ MessageBody: "hello" });
```

## Circular bindings

Bindings support circular references between resources. For example,
Worker A can bind Worker B and Worker B can bind Worker A. This works
because bindings attach data (policies, env vars) to the host via
the Stack — they don't create direct import dependencies.

To make circular bindings efficient for bundling, use the
[layer pattern](/concepts/platform#worker-layer) so each
Worker only imports the other's tiny class, not its full implementation.
