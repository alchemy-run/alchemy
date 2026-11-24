# Running processes

## Choose a harness

One Layer, with its storage and its coding tools. Nothing else changes between them.

```typescript
const HarnessLive = Layer.mergeAll(Pi.HarnessLive, Pi.CodingTools).pipe(
  Layer.provide(PiCloudflare.DurableObjectStorage),
);
```

```typescript
const HarnessLive = Layer.mergeAll(OpenCode.HarnessLive, OpenCode.CodingTools).pipe(
  Layer.provide(OpenCodeCloudflare.DurableObjectStorage),
);
```

More: [Run processes on Pi](https://alchemy.run/ai/harnesses#run-processes-on-pi), [Run them on OpenCode instead](https://alchemy.run/ai/harnesses#run-them-on-opencode-instead).

## Run sessions in a Durable Object

Yield the process in the outer Effect and provide one Layer. The methods are what the rest of the app may ask of a session.

```typescript
// src/Agents.ts
const Live = Layer.mergeAll(HarnessLive, AI.DefaultModel(Smart), PostAnswerLive).pipe(
  Layer.provide(Layer.mergeAll(SmartLlama, SandboxLive)),
  Layer.provide(Boat.CreateSandboxHttp),
);

export default class Agents extends Cloudflare.DurableObject<Agents>()(
  "Agents",
  Effect.gen(function* () {
    const triage = yield* Triage;

    return Effect.succeed({
      start: (issue: number) =>
        triage
          .get(String(issue))
          .send(`The issue is ${issue}.`, { requestId: "start" })
          .pipe(Effect.orDie),
      tell: (issue: number, text: string, id: string) =>
        triage.get(String(issue)).send(text, { requestId: id }).pipe(Effect.orDie),
    });
  }).pipe(Effect.provide(Live)),
) {}
```

Name the object after the session's key for one object per session (`agents.getByName(String(issue))`), or keep many sessions in one. A session started by another lives in the starter's object.

More: [Yield a process in a Durable Object](https://alchemy.run/ai/hosting#yield-a-process-in-a-durable-object), [One object for each session](https://alchemy.run/ai/hosting#one-object-for-each-session).

## Give tools a sandbox

```typescript
// src/Sandbox.ts
import * as AIBoat from "@alchemy.run/ai/Boat";
import * as Boat from "@alchemy.run/boat";

export const SandboxLive = AIBoat.Sandboxes(
  Boat.Snapshot("Checkout", { run: ["git clone https://github.com/acme/widgets ~/repo"] }),
);
```

E2B, Daytona, Modal and Archil have the same Layer under `@alchemy.run/ai/<Platform>`. Only tools that use `AI.Sandbox`, and the coding tools, need one.

More: [Say where sandboxes run](https://alchemy.run/ai/sandboxes#say-where-sandboxes-run).

## Sessions survive eviction

The harness arms the object's alarm while a session has work. An evicted object wakes up and the session carries on. Mark a tool `replay: "safe"` if its call may run again after a crash.

More: [A session survives its object](https://alchemy.run/ai/hosting#a-session-survives-its-object), [Say whether a call may run twice](https://alchemy.run/ai/tools#say-whether-a-call-may-run-twice).

## See what a session did

```typescript
const page = yield* triage.get(String(issue)).history({ take: 50 });
```

Each item is a message, the tools an answer called, or a tool's result. `events()` is the same items live, after the session's status.

More: [Read the transcript](https://alchemy.run/ai/processes#read-the-transcript), [Watch a session](https://alchemy.run/ai/processes#watch-a-session).

## Connect a front end

Make the session part of the Domain model, so a front end uses one Api.

- A `RecordActivity` command carries a batch: status, queue and items (`@alchemy.run/ai/Session` has the Schemas). Its aggregate drops items it already has.
- A view holds the status. A stream, appended by a projection, holds the transcript.
- The session's Durable Object reads `session.events({ after })` and sends the command. A job from `Alchemy.makeCallback` on the object's alarm records what is missing after an eviction, until the session is idle.
- The front end's Api lists only the commands a page may send. Acting on the session is a command that a policy passes on.

```typescript
yield* triage.get(issue).events({ after: recorded.seq }).pipe(
  Stream.groupedWithin(50, "100 millis"),
  Stream.runForEach((batch) => sessions.send(new RecordActivity(batchOf(issue, batch)))),
);
```

Without a model, serve a session over your own Effect RPC group from a `Cloudflare.RpcDurableObject`.

More: [Record what the session does](https://alchemy.run/ai/front-end#record-what-the-session-does), [Keep recording through an eviction](https://alchemy.run/ai/front-end#keep-recording-through-an-eviction), [Read it in a Foldkit app](https://alchemy.run/ai/front-end#read-it-in-a-foldkit-app), [Without a Domain model](https://alchemy.run/ai/front-end#without-a-domain-model).
