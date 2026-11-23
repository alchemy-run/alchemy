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
  Layer.provide(Layer.mergeAll(ModelsLive, SandboxLive)),
  Layer.provide(Boat.CreateSandboxHttp),
);

export default class Agents extends Cloudflare.DurableObject<Agents>()(
  "Agents",
  Effect.gen(function* () {
    const triage = yield* Triage;

    return Effect.succeed({
      start: (issue: number) => triage.start(String(issue), { issue }).pipe(Effect.orDie),
      tell: (issue: number, text: string, id: string) =>
        triage
          .get(String(issue))
          .send(text, { requestId: id })
          .pipe(Effect.catchTag("NotStarted", () => Effect.void), Effect.orDie),
    });
  }).pipe(Effect.provide(Live)),
) {}
```

Name the object after the session's key for one object per session (`agents.getByName(String(issue))`), or keep many sessions in one. A session started by another lives in the starter's object. Handle `NotStarted` inside the object.

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
const transcript = yield* triage.get(String(issue)).messages;
```

It is the harness's own transcript: every message, tool call and result.

More: [Wait, read and stop](https://alchemy.run/ai/processes#wait-read-and-stop).
