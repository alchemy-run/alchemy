---
title: Looping the Generation of Local Emulators
date: 2026-08-20T16:00:00Z
excerpt: The live test suite that generates our IaC and SDKs is also an executable spec of the cloud. Point it at an emulator and every red test is a fidelity bug with a repro. One convergence run took AWS emulation from 253 failures to 396 green tests, and alchemy dev now runs your AWS stack with no AWS account.
---

In [Looping the Generation of IaC and SDKs](/blog/2026-07-02-cloudflare-resource-factory)
we described the loop that builds Alchemy: fleets of AI agents
write resources and their live tests, run them against the real
cloud, and every API behavior the SDK's types don't capture
becomes a typed patch to the generated SDK. The resource is the
product; the truthful SDK is the byproduct.

The loop now has a second byproduct: a **local emulator**. What
makes it possible is the tests, and they cover both halves of the
cloud. The resource tests exercise the **control plane**: deploy
a resource, verify it out-of-band against the raw API, mutate it,
prove its destruction. The binding tests exercise the **data
plane**: a deployed function actually calling `putObject`,
`getItem`, `sendMessage` against the resources bound to it.
Together, thousands of them are an **executable specification of
the cloud**. Every consistency quirk, undocumented error code,
and misused HTTP status the factory ever caught is pinned as an
assertion.

An emulator has to satisfy the same specification. So we
extended the factory: point the same suite at a local emulator,
and every red test is a fidelity bug that arrives with its own
reproduction. This is how `alchemy dev` for AWS works. Your
stack runs on your machine with no AWS account and no
credentials. It shipped in
[2.0.0-beta.73](/blog/2026-08-20-beta-73).

## The fork

The emulator is [our fork](https://github.com/alchemy-run/floci)
of [floci](https://floci.io), an MIT-licensed, LocalStack-style
AWS emulator on the JVM. Our patches span about 30 services:
Lambda's streaming Function URLs, ELBv2's ALB data plane,
AppSync's Velocity template directives, EC2, IAM, SES, Cognito,
Athena, event-source mappings. Every one of them exists because
an alchemy test failed against the emulator after passing
against AWS.

We'd like to contribute these upstream. But the factory is a
fully automated fan-out, with fleets of agents producing fixes
faster than any maintainer could reasonably review. Flooding the
floci team with that maintenance burden isn't fair to them. It's
easier to let alchemy's flywheel drive the emulator's
development directly, and that requires a fork.

The test harness has one switch:

```sh
pnpm test:aws:floci
```

It runs the same test suite that normally runs against live AWS,
except every call goes to floci instead. Nothing is mocked: each
Lambda still cold-starts in its own Docker container.

In beta.73 we focused on patching the services floci already
supports: **219 resources across ~39 services** today. In the
next release we'll push for 100% local emulation of every AWS
service alchemy supports.

## One rule

Every test must pass unchanged against both real AWS and floci.
When a test goes red against the emulator, we never loosen the
test or special-case alchemy. The fix goes in the fork, with a
conformance test in the emulator's own suite.

For example: a live test asserts that a streaming Function URL
delivers its first bytes before the handler finishes. floci
buffered the stream, the test went red, the fix landed in the
fork, and streaming now behaves the same locally as in
`us-east-1`.

## Results

The first convergence run took the 13-service suite from **253
failures to 33**, with **396 tests green** against the emulator.
DynamoDB (105 tests), S3 (51), Step Functions (31), Cognito
(19), and others are fully green.

The result is [`alchemy dev` for AWS](/aws/local-development).
It also makes the factory cheaper: generation waves can now
iterate against floci with no rate limits, no
eventual-consistency stalls, and no leaked cloud resources,
touching the real cloud only to certify.

## Three artifacts per cloud

The end state we're building toward is a flywheel that, for each
cloud provider, produces three artifacts from one loop:

1. **Infrastructure-as-Code**: typed resources and bindings in
   Alchemy, with lifecycle logic whose error handling is
   verified against the live API.
2. **A refined spec and Effect-native SDK**: distilled, where
   every behavior a live test observes becomes a typed patch to
   the provider's spec, compounding for every future consumer.
3. **A local emulator**: held conformant to the same test suite
   that certifies the IaC, so `alchemy dev` is a faithful copy
   of `alchemy deploy`.

Each artifact makes the others cheaper. The refined SDK types
make lifecycle code generable. The lifecycle tests make the
emulator convergeable. The emulator makes the tests and your
dev loop free to run. And in the limit, the refined spec is
the substrate for all three: an emulator is just another
consumer of a spec, and every patch that teaches the spec what
the API really does is a piece of the emulator nobody has to
hand-write.

Cloudflare already runs this way: its Workers simulators are
built on workerd itself and held to the same live suites. AWS
now joins it. The next provider the factory brings up will ship
all three artifacts together.

- [2.0.0-beta.73 — the release AWS local dev shipped in](/blog/2026-08-20-beta-73)
- [AWS local development](/aws/local-development)
- [Looping the Generation of IaC and SDKs — the first post in this series](/blog/2026-07-02-cloudflare-resource-factory)
- [alchemy-run/floci — the fork](https://github.com/alchemy-run/floci)
- [distilled — the generated, patchable SDK](https://github.com/alchemy-run/distilled)
