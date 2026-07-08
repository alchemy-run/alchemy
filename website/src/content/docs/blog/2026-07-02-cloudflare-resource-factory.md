---
title: Generating 200+ Cloudflare Resources with AI
date: 2026-07-02
excerpt: Fleets of AI agents grew Alchemy's Cloudflare provider from 22 resources to 230 — the bulk of it in a single 22-hour run — each one live-tested against the real Cloudflare API. The mechanism that made it work is a flywheel — every API surprise a test hit became a patch to our generated SDK's type system, 720 of them, compiling Cloudflare's actual behavior into typed unions for every future consumer.
---

Between June 11 and June 17, Alchemy's Cloudflare provider grew
from **22 resources to 230**. Test suites went from 55 files to
288 — roughly 700 test cases, run against a real Cloudflare
account, not mocks. Most of it landed in a single PR
([#601](https://github.com/alchemy-run/alchemy-effect/pull/601)):
+101,178 lines across 542 files, open for 22 hours, written by
fleets of AI agents. The PR description, in its entirety:

> Using Fable to generate all missing cloudflare resources

Volume was never the hard part. Code generation has been able
to produce a hundred thousand lines of plausible
infrastructure code for a while now — code that compiles,
reads well, and lies. Real APIs return undocumented error
codes, misuse HTTP statuses, null out fields their schemas
declare required, and accept enum values their SDKs don't know
about. Generated code inherits every one of those lies, and
in infrastructure-as-code the lie surfaces at the worst
possible moment: mid-deploy, in your account.

So the interesting number from that run isn't 230 resources.
It's this one: **720 patches to our SDK's type system, each
one a place where a live test caught the API doing something
its spec doesn't admit to.**

![Cumulative patched operations in the distilled Cloudflare SDK, June 11-19 — a step line that jumps from 369 to 1,075 in the first 24 hours as PR #601 lands, then climbs slowly to 1,093 through the beta.56 and beta.57 releases](/blog/resource-factory/patches.svg)

## A software development flywheel

Alchemy's resources are built on
[distilled](https://github.com/alchemy-run/distilled), our
Effect-native SDK generated from Cloudflare's official
TypeScript SDK — 114 service modules, 2,092 operations, every
request and response an Effect Schema. Generated code is only
as truthful as its source, so distilled has a patch layer: a
JSON file per operation that corrects the spec where reality
disagrees with it.

The rule the whole run operated on: **agents never handle an
unknown error in their own code.** When a test hits an
unmatched error — an `UnknownCloudflareError`, or a temptation
to check `status === 404` — the fix is not a catch-block in
the resource. It's a patch to the SDK, followed by
regeneration. The catch-all error types exist only to surface
gaps; nothing is allowed to handle them.

Untyped failure handling is where AI-generated code usually
goes wrong: matching on message substrings, guessing at status
codes, swallowing errors that should have propagated. The rule
takes that option away — the code doesn't typecheck until the
SDK knows about the error.

It also makes the work compound. Every red test either fixes a
resource or improves the SDK, and a better SDK makes the next
resource, the next test, and the next agent more correct.

## One turn of the flywheel

Infrastructure-as-code is, on the inside, mostly disciplined
error handling. Deletes must tolerate already-gone. Creates
must absorb losing a race to a name that already exists. Reads
must ride out eventual-consistency windows where the API
briefly denies what it just did. That discipline is everywhere
in Alchemy's lifecycle code, and it's typed — you catch a tag,
or retry while a tag is observed; you never sniff a status
code or match a message string:

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

The agents write this code *first* — the reconciler, the
idempotent delete, the test cases for every lifecycle
operation — and then run it against the real API, where
reality pushes back. A Turnstile lifecycle test deletes a
widget, then reads it back to prove it's gone. The read fails
with Cloudflare error code `10404`, which the spec doesn't
declare — so the `catchTag` above doesn't even typecheck yet,
because `WidgetNotFound` isn't in `getWidget`'s error union,
and at runtime the failure surfaces as an unmatched catch-all
the resource isn't allowed to touch. Either way it lands, the
failure has exactly one permitted exit — a four-line patch in
distilled:

```json
// distilled/packages/cloudflare/patches/turnstile/getWidget.json
{
  "errors": {
    "WidgetNotFound": [{ "code": 10404 }, { "code": 10407 }],
    "Forbidden": [{ "status": 403 }]
  }
}
```

One command regenerates just that service:

```sh
bun scripts/generate.ts --service turnstile
```

Before the patch, the generated operation knew nothing beyond
transport errors:

```typescript
export type GetWidgetError = DefaultErrors;
```

After it, the union names what the API actually does, and the
generator emits a tagged class with the matchers baked in:

```typescript
export type GetWidgetError = DefaultErrors | WidgetNotFound | Forbidden;

export class WidgetNotFound extends T.applyErrorMatchers(
  Schema.TaggedErrorClass<WidgetNotFound>()("WidgetNotFound", {
    code: Schema.Number,
    message: Schema.String,
  }),
  [{ code: 10404 }, { code: 10407 }],
) {}
```

Now the `catchTag` compiles — fully inferred, no casts — the
test goes green, and the agent moves to the next lifecycle
operation. Around the loop goes: reconcile, read, diff,
delete, list, each operation's test cases forcing the next
correction, until the whole resource is green against the
live API. The resource is the product; the truthful SDK falls
out as a byproduct.

And the byproduct compounds: that patch doesn't belong to the
Turnstile resource, or to Alchemy. It belongs to the SDK.
Every future consumer of distilled's Turnstile module — ours
or anyone's — gets `WidgetNotFound` as a typed, catchable
error forever. The test didn't just verify a resource. It
compiled a piece of Cloudflare's actual behavior into the type
system.

## What 1,087 patches look like

By the beta.56 release the patch corpus stood at 1,087
operations — 52% of everything the SDK exposes, spanning 94 of
its 114 services. We parsed all of them:

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

The error tags are the bulk, and most are boring in the best
way — `Forbidden`, `WorkerNotFound`, `NoSuchBucket` — the
vocabulary any lifecycle operation needs. But the corpus is
also a catalog of the ways an API's documented surface drifts
from its behavior.

Some APIs misuse status codes, so a matcher has to read the
message. Cloudflare's Snippets API returns **400** — not
404 — for a missing snippet:

```json
// patches/snippets/getSnippet.json
{
  "errors": {
    "SnippetNotFound": [
      { "status": 400, "message": { "includes": "snippet not found" } },
      { "status": 404 }
    ]
  }
}
```

Some SDKs lag the API. Queues consumers support `http_pull`,
but the spec's enum doesn't say so — a request patch adds the
missing value:

```json
// patches/queues/createConsumer.json (excerpt)
{
  "request": {
    "properties": {
      "type": { "optional": false, "addValues": ["http_pull"] }
    }
  }
}
```

And some schemas are simply wrong about nullability — the spec
says these account-settings fields are always present; the
live API returns null:

```json
// patches/accounts/getAccount.json (excerpt)
{
  "response": {
    "properties": {
      "settings.abuse_contact_email": { "nullable": true },
      "settings.enforce_twofactor": { "nullable": true }
    }
  }
}
```

None of these are discoverable by reading documentation. Every
one was found by a test provisioning real infrastructure and
hitting the discrepancy, and every one is now permanent: the
generator refuses to run if a patch no longer matches an
operation, so a spec update can't silently drop what the tests
learned.

## The factory

The agents ran as a fleet — around twelve concurrent, each one
owning exactly one distilled service. Ownership is what keeps
a fleet coherent: only the owner of `turnstile` may write to
`patches/turnstile/` and regenerate `services/turnstile.ts`,
so two agents never race the generator. An agent implements
its service's resources, writes their live tests, runs them
against the real account, patches its service when a test
surfaces a lie, and repeats until green.

A few mechanical choices mattered more than any prompt:

**One workspace across two repos.** distilled is embedded in
the alchemy repo as a git submodule and included in its bun
workspaces, so the SDK and its consumer install together —
one `bun install`, one consistent dependency graph, and
`@distilled.cloud/cloudflare` resolves to the submodule
sitting right there in the checkout. An agent patches the SDK
and the resource that consumes it in the same working tree,
and a wave's output lands as two PRs: one to alchemy-effect,
one to distilled.

**Regeneration is instantly visible.** Our vitest config adds
the `bun` export condition, so tests resolve distilled from
its TypeScript source rather than built output:

```typescript
// packages/alchemy/vitest.config.ts
externalConditions: ["bun", "node", "module-sync"],
```

No compile step after regenerating a service — the moment the
generator writes `services/turnstile.ts`, the next test run
sees the new types. The flywheel's cycle time is the test's
runtime.

**Never wait on a hang.** Every test invocation ran under a
hard `timeout` kill, every retry was bounded, and polling for
anything slower than ~90 seconds was forbidden. Hitting the
wall *is* the failure: read the partial output, find the
unbounded retry or infinite pagination, fix the cause. An
agent transcript silent for five minutes got killed and
re-dispatched, and because every task prompt was worded
assess-first — "partial work may exist, finish it, don't
rewrite" — a killed agent's successor picked up where it died.

**A budget for stubbornness.** Three iterations. A suite still
red after three fix attempts, where the blocker is platform
behavior rather than our code, gets implemented fully,
skip-gated with the exact typed error recorded, and reported
honestly — not burned an hour on.

That last rule produced one of our favorite patterns.
Cloudflare gates entire products behind plans and
entitlements — Magic Transit, Total TLS, custom hostnames. The
factory couldn't lifecycle-test those on our account, but it
could pin the *gate itself* into the type system. Each gated
product got its rejection patched as a typed error
(`MagicTransitNotOnboarded`, code 1012;
`AdvancedCertificateManagerRequired`, code 1450) and a probe
test that always runs:

```typescript
// test/Cloudflare/MagicTransit/StaticRoute.test.ts
test.provider(
  "unentitled accounts surface the typed MagicTransitNotOnboarded error",
  (stack) =>
    Effect.gen(function* () {
      // ... resolve accountId; no-op early if this account is entitled ...

      // The typed tag — not UnknownCloudflareError, not a status check.
      const error = yield* magicTransit
        .listRoutes({ accountId })
        .pipe(Effect.flip);
      expect(["MagicTransitNotOnboarded", "Forbidden"]).toContain(error._tag);
    }),
);

test.provider.skipIf(!entitled)("list enumerates the deployed static route", ...);
```

The probe proves the patch and the gating are correct forever,
at near-zero cost; an entitled account flips one environment
variable and the full lifecycle suite runs unchanged. 136 of
the 288 test files carry gates like this.

The tests themselves follow one shape: deploy real
infrastructure, verify it **out-of-band** by querying the API
directly through distilled (227 of the test files import it
for exactly this), mutate, verify again, destroy, and prove
the destroy by watching the resource disappear — with a typed
`catchTag` on the not-found tag standing in for "gone".
Nothing counts because the deploy said so; everything is
checked against what Cloudflare actually reports.

## What broke at scale

Some of the run's most useful output was the damage. Fleet
work finds structural limits that no single-resource
development ever would.

The one that cost the most time: registering ~280 provider
layers in a single flat `Layer.mergeAll(...)` call doesn't
fail — it silently succeeds with the wrong type. The comment
that now lives in `Providers.ts`:

```typescript
// Split into nested groups: a single flat mergeAll with ~200
// arguments exceeds tsgo's variadic inference ceiling and
// silently drops the tail layers from the inferred union.
```

The symptom was a baffling cascade of
`Provider<X> is not assignable` errors across every test file,
pointing nowhere near the cause. Nested groups of ~90 fixed it.

The new fleet's own tests also caught the engine misbehaving.
With 233 new suites deploying and re-deploying, two
stable-attribute bugs that had always been latent became
constant noise: a Worker's `url` and its
`durableObjectNamespaces` were regenerated on every deploy
even when unchanged, phantom-updating everything downstream
([#616](https://github.com/alchemy-run/alchemy-effect/pull/616),
[#617](https://github.com/alchemy-run/alchemy-effect/pull/617)).
And a CLI that starts in 8.2 seconds is fine for a person but
brutal for a fleet running hundreds of plans — lazy-loading
the TUI and deferring distilled's schema construction got it
to 1.8s
([#618](https://github.com/alchemy-run/alchemy-effect/pull/618)).

Even the patch chart carries scars if you look closely: the
corpus *shrinks* a few times during the hardening tail
(1,083 → 1,080) where
review consolidated duplicate patches — and one agent left its
scratch probe, `.ai-workspace/web3-probe.ts`, sitting in the
merged PR. Shipped fast, cleaned up after.

## What the agents didn't do

The honest version of "AI wrote 200 resources" includes what
was already standing when it did.

The doctrine came first, by hand. The reconciler shape
(observe → ensure → sync → return), the typed-error rule, the
test conventions with destroy-bookends and out-of-band
verification — all of it was established on hand-built
resources and written down before any fleet ran. In the days
just before #601, [Andy
Jefferson](https://github.com/microagi-andy) contributed
DnsRecord and five Zero Trust resources built exactly to that
doctrine
([#570](https://github.com/alchemy-run/alchemy-effect/pull/570))
— about 5,100 lines over two and a half days of careful work.
The factory didn't replace that kind of engineering; it
scaled it. Every agent prompt pointed at the doctrine and at
exemplar resources, and the difference between "AI slop" and
what shipped is precisely that scaffolding: agents were never
asked to invent judgment, only to apply written-down judgment
several hundred times under a type system that refuses lies.

A coordinator (human plus one orchestrating session) stayed in
the loop throughout: the authoritative type-checks,
cross-cutting fixes like the `mergeAll` restructure, and the
call on what was out of scope — deprecated APIs superseded by
Rulesets, billing objects, closed betas — all stayed
centralized.

And the map has known edges. When beta.56 shipped, twenty of
distilled's 114 services had no patches at all, and over a
thousand operations still carried only default transport
errors — mostly paths no resource exercises yet.
Entitlement-gated lifecycles are pinned by probes but not run
in anger on our account. The corpus is a record of every road
actually driven, not a claim that every road is paved.

## Where this lands

The 230 resources are the visible output, and they shipped in
[2.0.0-beta.56](/blog/2026-06-17-beta-56). But the durable
output is the SDK. Resources are rewritten as engines evolve —
the patch corpus survives all of it, because it encodes facts
about Cloudflare, not facts about Alchemy: this operation
returns 10404 for a missing widget, that one misuses 400,
these fields come back null. 1,099 operations' worth of those
facts now regenerate into typed unions on every build, for
every consumer.

That's also why this template travels. The factory needs three
things: a generated SDK with a patch layer, a live account to
test against, and a doctrine that forbids handling unknown
errors locally. Nothing about that is Cloudflare-specific —
AWS, Neon, PlanetScale, and Stripe sit in distilled behind
the same generator-plus-patches architecture. The Cloudflare
run was the proof; the same flywheel is how every provider
gets built from here.

- [2.0.0-beta.56 — the release these resources shipped in](/blog/2026-06-17-beta-56)
- [PR #601 — the generation wave](https://github.com/alchemy-run/alchemy-effect/pull/601)
- [distilled — the generated, patchable SDK](https://github.com/alchemy-run/distilled)
- [Cloudflare provider reference](/providers/cloudflare)
