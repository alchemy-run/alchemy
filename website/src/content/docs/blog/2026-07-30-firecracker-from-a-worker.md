---
title: Boot a Firecracker microVM from a Cloudflare Worker
date: 2026-07-30
draft: true
excerpt: One binding line in a Cloudflare Worker — `yield* AWS.Lambda.RunMicrovm(Sandbox)` — and the deploy provisions the entire IAM bridge into AWS. At request time the Worker boots a real Firecracker VM in a few seconds, calls it over typed RPC, and tears it down.
---

<!-- VIDEO EMBED: firecracker-from-a-worker -->

A request hits a Worker on Cloudflare's edge. The Worker asks
AWS for a fresh Firecracker microVM, waits a few seconds for it
to boot, calls a typed method on the program running inside it,
returns the answer, and terminates the VM. Here is the entire
Worker — the same one that ran in our
[published benchmark](/blog/2026-07-01-microvm-cold-starts):

```typescript
export default Cloudflare.Worker(
  "MicrovmBenchWorker",
  { main: import.meta.filename },
  Effect.gen(function* () {
    const run = yield* AWS.Lambda.RunMicrovm(EffectfulBun);
    const auth = yield* AWS.Lambda.CreateAuthToken(EffectfulBun);
    const terminate = yield* AWS.Lambda.TerminateMicrovm(EffectfulBun);

    return {
      fetch: Effect.gen(function* () {
        const vm = yield* run({});
        const { authToken } = yield* auth({
          microvmIdentifier: vm.microvmId,
          expirationInMinutes: 5,
          allowedPorts: [{ port: 8080 }],
        });
        const sandbox = yield* AWS.Lambda.connectMicrovm(EffectfulBun, {
          endpoint: vm.endpoint,
          authToken,
        });
        const greeting = yield* sandbox.hello("bench");
        yield* terminate({ microvmIdentifier: vm.microvmId });
        return HttpServerResponse.text(greeting);
      }),
    };
  }),
);
```

The three binding lines at the top are the Worker's entire
relationship with AWS. Each one does two jobs: at deploy time it
registers the IAM grant the operation needs, and at runtime it
returns the typed client that performs it. The credentials, the
policies, and the role that carries them are all generated from
those calls.

The exact flow ships as a live test —
["drives the MicroVM from a Cloudflare Worker (cross-cloud
assume-role)"](https://github.com/alchemy-run/alchemy-effect/blob/main/packages/alchemy/test/AWS/Lambda/MicrovmImage.test.ts)
— which deploys the Worker, boots a VM, round-trips a typed RPC
call and a raw HTTPS fetch into it, and terminates it.

## The binding builds the bridge

A Lambda Function binding `RunMicrovm` has it easy: Alchemy adds
`lambda:RunMicrovm` scoped to that image's ARN onto the
function's execution role, and the runtime signs requests with
credentials AWS already put in the environment.

A Worker has no execution role — so the binding builds one. When
the host is a Cloudflare Worker, the deploy provisions, once per
Worker ([MicrovmBinding.ts](https://github.com/alchemy-run/alchemy-effect/blob/main/packages/alchemy/src/AWS/Lambda/MicrovmBinding.ts)):

- an IAM **User** whose only permission is `sts:AssumeRole`,
- an **AccessKey** for that user, bound into the Worker as a
  secret,
- an IAM **Role** that trusts only that user — the role every
  MicroVM permission accumulates on.

The deploy plan makes the bridge visible:

```sh
❯ bun alchemy deploy
Apply  5 to create
  ✓ Sandbox                       AWS.Lambda.MicrovmImage
  ✓ MicrovmWorker-microvm-user    AWS.IAM.User
  ✓ MicrovmWorker-microvm-key     AWS.IAM.AccessKey
  ✓ MicrovmWorker-microvm-role    AWS.IAM.Role
  ✓ MicrovmWorker                 Cloudflare.Worker
```

Every statement on that Role is one of the least-privilege
statements generated from binding calls: `RunMicrovm` grants
`lambda:RunMicrovm` on the exact image ARN; the instance
operations (`GetMicrovm`, `TerminateMicrovm`, `CreateAuthToken`)
grant their actions on the image and the `microvm:*` instance
glob derived from it. Delete a binding line and its statement
leaves the plan.

The User's inline policy allows `sts:AssumeRole` on `*` — but
assumption is authorized on the *other* side: the Role's trust
policy names exactly one principal, so the key can assume this
role and nothing else:

```typescript
const role = yield* Role(`${id}-microvm-role`, {
  assumeRolePolicyDocument: {
    Version: "2012-10-17",
    Statement: [
      {
        Effect: "Allow",
        Principal: { AWS: user.userArn },
        Action: ["sts:AssumeRole"],
      },
    ],
  },
});
```

At runtime the Worker uses the access key for exactly one
operation: `AssumeRole`. Everything else is signed with the
short-lived session credentials that come back — cached,
refreshed near expiry, and shared across every binding on the
Worker, so the STS call happens once per isolate rather than
once per request.

## Booting on request

The thing being booted is itself a TypeScript program.
[`AWS.Lambda.MicrovmImage`](/aws/compute/microvms) bundles it,
builds the image server-side on AWS, runs the entrypoint, and
takes a Firecracker snapshot of the running memory — so the
program's startup cost is paid once, at build time:

```typescript
export class Sandbox extends AWS.Lambda.MicrovmImage<
  Sandbox,
  { hello: (message: string) => Effect.Effect<string> }
>()("Sandbox") {}
```

The `{ hello }` shape is [Schemaless RPC](/apis/schemaless) —
the same `{ fetch, ...rpcs }` contract a Worker, a Durable
Object, or a Container returns. `sandbox.hello("world")` on the
caller is a typed stub; change the method's signature in the VM
and the Worker fails to compile.

At request time, the lifecycle is an Effect — which means
cleanup composes the way everything else does. Launch the VM,
do the work, and guarantee termination on success *or* failure
with `Effect.ensuring`:

```typescript
const vm = yield* runMicrovm({});
return yield* Effect.gen(function* () {
  // (wait until the MicroVM reaches RUNNING — retry loop elided)
  const { authToken } = yield* createAuthToken({
    microvmIdentifier: vm.microvmId,
    expirationInMinutes: 5,
    allowedPorts: [{ port: 8080 }],
  });
  const sandbox = yield* AWS.Lambda.connectMicrovm(Sandbox, {
    endpoint: vm.endpoint,
    authToken,
  });
  const reply = yield* sandbox.hello("world"); // "hello, world!"
  return yield* HttpServerResponse.json({ reply });
}).pipe(
  // terminate on success OR failure — never leak a running MicroVM
  Effect.ensuring(
    terminateMicrovm({ microvmIdentifier: vm.microvmId }).pipe(
      Effect.ignore,
    ),
  ),
);
```

A failure mid-request — a timeout, a client hangup, an error in
the sandboxed code — still runs the terminate. VMs never leak
against your account's memory quota.

## A per-user agent sandbox

The reason to want this shape is agents: give every user (or
every session) a fully isolated VM that exists only for the
duration of the work. The image can be any Dockerfile — here is
the entire [opencode](https://opencode.ai) sandbox image from
the benchmark:

```dockerfile
FROM public.ecr.aws/lambda/microvms:al2023-minimal
RUN curl -fsSL https://opencode.ai/install | bash
WORKDIR /workspace
ENTRYPOINT ["opencode", "serve", "--hostname", "0.0.0.0", "--port", "8080"]
```

Because the image build runs the entrypoint and snapshots the
running process, a 100 MB coding agent resumes from snapshot the
same way a 15-line server does. Booted from a Worker, the
opencode VM answers its first real request in **~3.6 seconds at
the median, 4.2s worst case across the whole run** — and
crossing clouds costs nothing measurable: Worker → MicroVM lands
within noise of Lambda → MicroVM on every variant. Those numbers
and the full methodology are in the
[benchmark post](/blog/2026-07-01-microvm-cold-starts); the
benchmark app itself is a runnable Alchemy program at
[`benchmark/container`](https://github.com/alchemy-run/alchemy-effect/tree/main/benchmark/container).

So the request trace at the top is a real product shape: user
prompt in at the edge, a private Firecracker VM up about three
and a half seconds later, the agent's answer comes back, the VM
is gone.

## What we'd change

Three caveats, the same ones the benchmark post conceded:

- **The bridge holds a long-lived key.** The AccessKey bound
  into the Worker can mint short-lived credentials and do
  nothing else, and the permissions live on the Role — but
  ideally the User wouldn't exist at all. OIDC federation from
  the Worker straight into the Role is where we want to take
  this.
- **`RunMicrovm` is soft-limited at 5 TPS per account** (burst
  of 5). It's the standard AWS ask-and-it's-raised friction
  pattern, not a capacity ceiling — but a fresh account should
  design around it.
- **MicroVMs are an AWS preview feature.** Your account must be
  onboarded, effectful builds need a bootstrapped Assets bucket
  (`alchemy aws bootstrap`), and image builds are asynchronous —
  they take minutes, not seconds.

## Where to go next

- [Lambda MicroVMs](/aws/compute/microvms) — image modes,
  lifecycle bindings, `connectMicrovm`, and the fetch route.
- [Benchmarking Cloudflare Containers vs AWS MicroVMs](/blog/2026-07-01-microvm-cold-starts)
  — the numbers behind every claim above.
- [Schemaless RPC](/apis/schemaless) — the typed contract the
  sandbox stub speaks.
- [`benchmark/container`](https://github.com/alchemy-run/alchemy-effect/tree/main/benchmark/container)
  — the benchmark as a runnable app: change a variant, run
  `bun bench`, see for yourself.

Alchemy is in beta — APIs may still move. Try it today:

```sh
bun add alchemy@next
```
