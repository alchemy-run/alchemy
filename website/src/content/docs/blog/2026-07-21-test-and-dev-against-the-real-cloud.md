---
title: "Deploy → assert → destroy: testing and hot-reloading the real cloud"
date: 2026-07-21
draft: true
excerpt: Your test suite deploys a real, isolated stack — real R2, real Worker — asserts over live HTTP, and destroys it. Then `alchemy dev` hot-reloads your Worker in 42ms against the same real cloud resources.
---

<!-- VIDEO EMBED: test-and-dev-against-the-real-cloud -->

This is the entire integration suite for a Worker that reads
and writes an R2 bucket. It deploys the real stack, drives the
live URL, and tears the stack down when it's done:

```typescript
// test/integ.test.ts
import * as Cloudflare from "alchemy/Cloudflare";
import * as Test from "alchemy/Test/Bun";
import { expect } from "bun:test";
import * as Effect from "effect/Effect";
import * as HttpBody from "effect/unstable/http/HttpBody";
import * as HttpClient from "effect/unstable/http/HttpClient";
import Stack from "../alchemy.run.ts";

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: Cloudflare.providers(),
  state: Cloudflare.state(),
});

const stack = beforeAll(deploy(Stack));
afterAll.skipIf(!process.env.CI)(destroy(Stack));

test(
  "PUT and GET round-trip an object",
  Effect.gen(function* () {
    const { url } = yield* stack;

    const put = yield* HttpClient.put(`${url}/hello.txt`, {
      body: HttpBody.text("Hello, World!"),
    });
    expect(put.status).toBe(201);

    const get = yield* HttpClient.get(`${url}/hello.txt`);
    expect(yield* get.text).toBe("Hello, World!");
  }),
);

test(
  "GET missing key returns 404",
  Effect.gen(function* () {
    const { url } = yield* stack;
    const response = yield* HttpClient.get(`${url}/no-such-key`);
    expect(response.status).toBe(404);
  }),
);
```

```sh
bun test test/integ.test.ts
```

The bucket that `hello.txt` lands in is a real R2 bucket. The
URL the tests GET is a live `workers.dev` deployment. Every
assertion travels over the public internet to code running on
Cloudflare's edge — the suite tests exactly what production
runs.

## A stack per test suite

`Test.make` wires your provider Layer and state store into the
test runner once per file — the same `Cloudflare.providers()`
and `Cloudflare.state()` your [Stack](/infrastructure-as-code/stack)
already uses. `beforeAll(deploy(Stack))` deploys once for the
whole file and returns a lazy accessor every test can `yield*`
to read the stack's outputs:

```typescript
const stack = beforeAll(deploy(Stack));

test(
  "worker returns a url",
  Effect.gen(function* () {
    const { url } = yield* stack;

    expect(url).toBeString();
  }),
);
```

The first run deploys; re-runs diff and skip unchanged
resources, so the second `bun test` is fast. Tests default to
the isolated `test` [stage](/environments/stages), so the suite
deploys its own physical resources — its own state file, its
own physical names — and your dev deployment stays untouched.
On CI, give every PR its own stage and suites run in parallel
against one account:

```typescript
const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: Cloudflare.providers(),
  stage: `pr-${process.env.PR_NUMBER}`,
});
```

The step-by-step walkthrough is
[Tutorial Part 3](/cloudflare/tutorial/part-3); the full pattern
reference is [Testing a Stack](/testing/testing-a-stack).

## Asserting over live HTTP

`HttpClient` is already in scope in every test Effect. The one
wrinkle of testing the real edge: fresh `workers.dev` URLs
transiently 404/5xx while routes, bindings, and DNS propagate.
The harness ships `getWhenReady` to ride out that window on the
first request:

```typescript
const { getWhenReady } = Test;

test(
  "worker answers once the edge converges",
  Effect.gen(function* () {
    const { url } = yield* stack;

    const response = yield* getWhenReady(url);
    expect(response.status).toBe(200);
  }),
);
```

It retries only 404/5xx — 20 attempts, exponential from 500ms —
so a deliberate `403` assertion observes the `403` immediately.
For arbitrary effects, use a bounded declarative retry:

```typescript
import * as Schedule from "effect/Schedule";

const response = yield* HttpClient.get(`${url}/health`).pipe(
  Effect.retry({ schedule: Schedule.exponential("500 millis"), times: 10 }),
);
```

## Destroy is part of the test

Teardown is one hook, and it's conditional on where you're
running:

```typescript
afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(Stack)); // keep alive with NO_DESTROY=1
afterAll.skipIf(!process.env.CI)(destroy(Stack));          // destroy on CI only
```

On CI the stack is torn down after every run — ephemeral
environments that actually end. Locally, skipping the destroy
is the feature: the deployed stack plus cached state make
re-runs near-instant, so you iterate on assertions against a
warm deployment and only pay the deploy once.

## `alchemy dev`

Tests close the loop on correctness; `alchemy dev` closes the
loop on speed:

```sh
bun alchemy dev
```

```
✓ Bucket (Cloudflare.R2.Bucket)  created
✓ Worker (Cloudflare.Worker)     created (local → workerd)
  • http://localhost:1337

Watching for changes ...
```

Three things happen:

1. **Infrastructure deploys to the cloud** — the R2 bucket is a
   real R2 bucket on the real provider, full fidelity.
2. **Your Worker runs locally in workerd** — the same runtime
   production uses, with a proxy routing between the cloud and
   your local process.
3. **File changes hot reload** — edit the handler and:

```
↻ src/worker.ts changed
  • Rebuilding worker ...
✓ Worker reloaded in 42ms
```

A two-digit-millisecond reload, and the request that follows it
reads from the same real bucket. `dev` deploys into your
personal stage (`dev_$USER` by default), so your loop never
collides with teammates or prod. And because the Worker runs
locally, you can attach a debugger — breakpoints, variables,
call stacks — with real binding data in scope.

Frontends join the same loop: Vite, Next, any dev server runs
as a [`Command.Dev`](/command/dev-servers) resource — started
by `alchemy dev`, restarted when its inputs change, a no-op on
deploy. The [SolidStart](https://github.com/alchemy-run/alchemy-effect/tree/main/examples/cloudflare-solidstart),
[TanStack](https://github.com/alchemy-run/alchemy-effect/tree/main/examples/cloudflare-tanstack),
and [Vue](https://github.com/alchemy-run/alchemy-effect/tree/main/examples/cloudflare-vue)
examples all wire a framework dev server into the stack this way.

The full mechanics are in
[Local development](/environments/local-development) and
[Tutorial Part 4](/cloudflare/tutorial/part-4).

## `dev: true`

The two loops compose. The test harness has its own `dev` flag
that flips every Worker over to workerd inside the test process
— the same wiring as `bun alchemy dev`, embedded in the suite:

```diff lang="typescript"
// test/integ.test.ts
const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: Cloudflare.providers(),
  state: Cloudflare.state(),
+ dev: true,
});
```

`beforeAll(deploy(Stack))` now boots the Workers locally; the
HTTP assertions hit `http://localhost:1337` and round-trip into
your code with full stack traces — and a debugger you can
attach mid-test.

Rather than hardcoding it, read it from the environment so the
same file runs against real cloud resources on CI and local
workerd on your laptop:

```sh
ALCHEMY_DEV=1 bun test test/integ.test.ts
```

Drop the explicit flag and the harness falls back to the
`ALCHEMY_DEV` env var — one integration suite, two execution
modes, selected by the environment it runs in.

## Where to go next

- [Testing a Stack](/testing/testing-a-stack) — the end-to-end pattern reference.
- [Test harness](/testing/test-harness) — every helper, hook, and option on `Test.make`.
- [Tutorial Part 3: Testing](/cloudflare/tutorial/part-3) — your first integration test, step by step.
- [Tutorial Part 4: Local Dev](/cloudflare/tutorial/part-4) — `alchemy dev` and `dev: true`, step by step.
- [Local development](/environments/local-development) — how the dev loop works under the hood.
- [Stages](/environments/stages) — how `test`, `dev_$USER`, and `pr-42` stay isolated.

Alchemy is in beta — APIs may still shift between releases:

```sh
bun add alchemy@next
```
