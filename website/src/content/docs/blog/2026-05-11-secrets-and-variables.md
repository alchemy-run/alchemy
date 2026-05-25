---
title: Secrets and Variables
date: 2026-05-11
excerpt: Bind a value into your deploy target's env and get back a typed runtime accessor — the same one-liner works for Cloudflare Workers and AWS Lambda.
---

Wiring an env var into a deploy target is supposed to be the
boring part of a stack — but in practice it usually leaks across
two or three files: a value pulled out of `.env`, a binding
declared on the resource, and an unsafe `env.MY_KEY!` somewhere in
your handler.

`Alchemy.Secret` and `Alchemy.Variable` collapse all of that into
a single line that's also a typed runtime accessor.

```typescript
const apiKey = yield* Alchemy.Secret("OPENAI_API_KEY");
//    ^? Output<Redacted<string>>
```

That one yield does three things:

- reads the value from the active
  [`ConfigProvider`](https://effect.website/docs/configuration)
  at deploy time (no `process.env.X!` needed)
- attaches it to the active deploy target's environment as the
  platform's secret binding (Cloudflare → `secret_text`,
  Lambda → encrypted env var)
- hands you back an accessor — `yield* apiKey` inside `fetch`
  resolves the value at runtime, typed as `Redacted<string>`

## One API, every runtime

The same call works whether the active runtime is a Cloudflare
Worker, an AWS Lambda, or anything else that implements Alchemy's
serverless contract. Each provider routes the value to its native
secret/variable binding under the hood:

```typescript
// Cloudflare Worker
export default Cloudflare.Worker("Worker", { main: import.meta.path },
  Effect.gen(function* () {
    const apiKey = yield* Alchemy.Secret("OPENAI_API_KEY");
    return {
      fetch: Effect.gen(function* () {
        const key = yield* apiKey; // Redacted<string>
        return HttpServerResponse.text(`got ${Redacted.value(key).length} chars`);
      }),
    };
  }),
);

// AWS Lambda — exact same shape
export default AWS.Lambda.Function("Function", { main: import.meta.filename, url: true },
  Effect.gen(function* () {
    const apiKey = yield* Alchemy.Secret("OPENAI_API_KEY");
    return {
      fetch: Effect.gen(function* () {
        const key = yield* apiKey;
        return HttpServerResponse.text(`got ${Redacted.value(key).length} chars`);
      }),
    };
  }),
);
```

## Plain values when you don't need redaction

`Alchemy.Variable` is the same shape without the `Redacted`
wrapper. Strings deploy as `plain_text`, anything else as JSON,
and the runtime accessor returns the original type:

```typescript
const port = yield* Alchemy.Variable("PORT", 3000);
const flags = yield* Alchemy.Variable("FLAGS", { beta: true });

// later, in fetch:
const p = yield* port; // number — 3000
const f = yield* flags; // { beta: true }
```

No JSON parsing, no `as` casts — the type you put in is the type
you get back.

## Four input shapes

Both helpers accept a literal, an `Effect`, a `Config`, or default
to reading from `Config` under the same name:

```typescript
Alchemy.Secret("API_KEY");                              // Config.redacted("API_KEY")
Alchemy.Secret("API_KEY", "sk-123");                    // string literal
Alchemy.Secret("API_KEY", Effect.succeed("sk-123"));    // Effect<string | Redacted>
Alchemy.Secret("API_KEY", Config.string("OPENAI_KEY")); // Config<string | Redacted>
```

The last two are where this earns its keep: pull a token from a
vault inside an `Effect`, or rename it on the way through with
`Config.string("OTHER_NAME")` — the binding on the deploy target
is still `API_KEY`, the source just changed.

## Where to go next

- [Concepts › Secrets and Variables](/concepts/secrets) — how the
  bind/use phases work and how to choose between `Alchemy.Secret`,
  `Alchemy.Variable`, and the platform's own secret-store
  resources.
- [Guides › Secrets and env vars](/guides/secrets) — the full
  step-by-step for taking `OPENAI_API_KEY` from `.env` to a
  `secret_text` binding on a Worker.
