---
title: Looping the Generation of IaC and SDKs
date: 2026-07-02
excerpt: A loop for generating infrastructure-as-code — AI agents write resources and live tests, run them against the real API, and every unmatched error becomes a typed patch to our generated SDK. One run grew Alchemy's Cloudflare provider from 22 resources to 230 and patched 720 SDK operations, most of it in 22 hours.
---

![The generation loop — write resources and live tests, run them against the real API, every unmatched error becomes an SDK patch and regeneration, retest until green, then ship the IaC and the truthful SDK together](/blog/resource-factory/loop.svg)

This loop grew Alchemy's Cloudflare provider from **22
resources to 230** between June 11 and June 17: fleets of AI
agents write the resources and their live tests, run them
against a real Cloudflare account — not mocks — and every API
behavior the SDK's types don't capture becomes a patch to the
SDK, which regenerates and the tests rerun. One run produced
288 test files (~700 tests), **720 SDK patches**, and most of
it landed in a single PR
([#601](https://github.com/alchemy-run/alchemy-effect/pull/601)):
+101,178 lines across 542 files, open for 22 hours. The PR
description, in its entirety:

> Using Fable to generate all missing cloudflare resources

Volume is not the hard part. Deterministic codegen has been
producing SDKs and IaC providers from API specs for years, and
AI makes it even cheaper. The problem is that code generated
from a spec is only as truthful as the spec, and real APIs
drift from their specs: undocumented error codes, misused HTTP
statuses, fields that come back null where the schema says
they can't. That's why the interesting number isn't the 230
resources — it's the 720 patches, each one a place where a
live test caught the API doing something its spec doesn't
admit to.

![Cumulative patched operations in the distilled Cloudflare SDK, June 11-19 — a step line that jumps from 369 to 1,075 in the first 24 hours as PR #601 lands, then climbs slowly to 1,093 through the beta.56 and beta.57 releases](/blog/resource-factory/patches.svg)

## A software development flywheel

Alchemy's resources are built on
[distilled](https://github.com/alchemy-run/distilled), our
Effect-native SDK generated from Cloudflare's official
TypeScript SDK — 114 services, 2,092 operations. distilled has
a patch layer: a JSON file per operation that corrects the
spec where reality disagrees with it.

The rule the run operated on: **agents never handle an unknown
error in their own code.** An unmatched error is never caught
in the resource — it becomes an SDK patch, then a
regeneration. Untyped failure handling is where AI-generated
code usually goes wrong (matching message substrings, guessing
status codes); the rule takes that option away, because the
code doesn't typecheck until the SDK knows about the error. It
also makes the work compound: every red test either fixes a
resource or improves the SDK for the next one.

## One turn of the flywheel

Infrastructure-as-code is mostly disciplined error handling:
deletes tolerate already-gone, creates absorb losing a race,
reads ride out eventual consistency. In Alchemy that
discipline is typed:

```typescript
// idempotent delete: reading back an already-gone widget is success
turnstile.getWidget({ accountId, sitekey }).pipe(
  Effect.catchTag("WidgetNotFound", () => Effect.succeed(undefined)),
);

// R2's endpoint lags a fresh bucket create — retry the not-found until it settles
r2.listBucketDomainCustoms({ accountId, bucketName }).pipe(
  Effect.retry({
    while: (e) => e._tag === "NoSuchBucket",
    schedule: Schedule.exponential("100 millis").pipe(
      Schedule.both(Schedule.recurs(5)),
    ),
  }),
);
```

The agents write this code first, then run it against the real
API. A Turnstile test deletes a widget and reads it back to
prove it's gone; the read fails with code `10404`, which the
spec doesn't declare. The `catchTag` doesn't typecheck —
`WidgetNotFound` isn't in the error union — and the only
permitted fix is a patch in distilled:

```json
// distilled/packages/cloudflare/patches/turnstile/getWidget.json
{
  "errors": {
    "WidgetNotFound": [{ "code": 10404 }, { "code": 10407 }],
    "Forbidden": [{ "status": 403 }]
  }
}
```

Regenerate the service (`bun scripts/generate.ts --service
turnstile`) and the union names what the API actually does:

```typescript
export type GetWidgetError = DefaultErrors | WidgetNotFound | Forbidden;
```

The `catchTag` compiles, the test goes green, and the loop
continues — reconcile, read, diff, delete, list — until the
resource is green against the live API. The resource is the
product; the truthful SDK is the byproduct. The patch lives in
the SDK, not Alchemy: anyone who uses distilled's Turnstile
module from now on gets `WidgetNotFound` as a typed, catchable
error.

## What 1,087 patches look like

By beta.56 the corpus stood at 1,087 patched operations — 52%
of the SDK, spanning 94 of 114 services:

|  | count |
| --- | --- |
| patches declaring typed errors | 1,070 |
| patches fixing a response schema | 173 |
| patches fixing a request schema | 26 |
| distinct error tags introduced | 425 |
| matchers on Cloudflare error `code` | 1,367 |
| matchers on HTTP `status` | 994 |
| matchers needing `message.includes` | 377 |
| matchers needing a regex | 0 |

Most tags are the vocabulary lifecycle code needs —
`Forbidden`, `WorkerNotFound`, `NoSuchBucket`. The rest
catalog how APIs drift from their docs: Snippets returns
400 — not 404 — for a missing snippet (matched on the
message), Queues consumers support `http_pull` but the spec's
enum doesn't include it, account settings come back null where
the schema says they can't. None of this is discoverable by
reading documentation, and all of it is permanent: the
generator refuses to run if a patch no longer matches an
operation.

## The factory

Around twelve agents ran concurrently, each owning one
distilled service — only the owner of `turnstile` writes to
`patches/turnstile/`, so agents never race the generator.
Every test follows one shape: deploy, verify out-of-band by
querying the API directly through distilled, mutate, verify
again, destroy, and prove the destroy by watching the resource
disappear. Nothing counts because the deploy said so.

Two choices kept the loop fast. distilled is a git submodule
inside alchemy's bun workspace, so an agent patches the SDK
and the resource that consumes it in one working tree — a
wave lands as two PRs, one to alchemy-effect and one to
distilled. And vitest resolves distilled from its TypeScript
source, so a regenerated service is visible to the very next
test run; the flywheel's cycle time is the test's runtime.

## What the agents didn't do

The doctrine came first, by hand: the reconciler shape, the
typed-error rule, the test conventions. Days before #601,
[Andy Jefferson](https://github.com/microagi-andy) built
DnsRecord and five Zero Trust resources to that doctrine
([#570](https://github.com/alchemy-run/alchemy-effect/pull/570))
— 5,100 lines over two and a half days. The factory scaled
that work rather than replacing it: agents applied
written-down judgment a few hundred times under a type system
that refuses lies.

Coverage has known edges: 20 of 114 services have no patches
yet, and plan-gated products (Magic Transit, Total TLS) are
tested only up to the gate.

## Where this lands

The resources shipped in [2.0.0-beta.56](/blog/2026-06-17-beta-56).
The durable output is the SDK: patches encode facts about
Cloudflare, not Alchemy — this operation returns 10404 for a
missing widget, that one misuses 400 — so they outlive every
rewrite of the resources that found them. 1,099 patched
operations now regenerate into typed unions on every build,
for every consumer.

The factory needs a generated SDK with a patch layer, a live
account, and the rule against handling unknown errors locally.
AWS, Neon, PlanetScale, and Stripe already sit in distilled
behind the same architecture. Cloudflare was the proof; every
provider gets built this way from here.

- [2.0.0-beta.56 — the release these resources shipped in](/blog/2026-06-17-beta-56)
- [PR #601 — the generation wave](https://github.com/alchemy-run/alchemy-effect/pull/601)
- [distilled — the generated, patchable SDK](https://github.com/alchemy-run/distilled)
- [Cloudflare provider reference](/providers/cloudflare)
