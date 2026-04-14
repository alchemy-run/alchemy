---
title: Getting Started
description: Install Alchemy and deploy your first stack in under five minutes.
sidebar:
  order: 1
---

## Install

```sh
bun add alchemy effect
```

## Create a stack

Create an `alchemy.run.ts` at the root of your project:

```typescript
// alchemy.run.ts
import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import Api from "./src/Api.ts";

export default Alchemy.Stack(
  "MyApp",
  { providers: Cloudflare.providers() },
  Effect.gen(function* () {
    const api = yield* Api;
    return { url: api.url };
  }),
);
```

## Write a handler

```typescript
// src/Api.ts
import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

export default class Api extends Cloudflare.Worker<Api>()(
  "Api",
  { main: import.meta.path },
  Effect.gen(function* () {
    return {
      fetch: Effect.succeed(HttpServerResponse.text("Hello, world!")),
    };
  }),
) {}
```

## Deploy

```sh
alchemy deploy
```

You'll see a plan of what will be created. Confirm, and your Worker
will be live at the printed URL.

## What's next

- Read [Effect vs Async](/concepts/effect-vs-async) to understand the two ways
  to write programs with Alchemy.
- Jump into the [Effect](/guides/effect/overview) or [Async](/guides/async/overview)
  guides to start building.
