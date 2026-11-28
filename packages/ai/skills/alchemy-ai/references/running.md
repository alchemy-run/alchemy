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

## Host the model, then the process

Host the model as any model is. Then give `AICloudflare.layerDurableObjects` the prose of each process, provided with what a session runs on and the models it mentions. It gives back the same process, with one Durable Object for each session, named after its key. Do not write the object.

```typescript
// src/Worker.ts
const Agents = Layer.mergeAll(HarnessLive, AI.DefaultModel(Smart), PostAnswerLive).pipe(
  Layer.provide(Layer.mergeAll(SmartLlama, SandboxLive)),
  Layer.provide(Boat.CreateSandboxHttp),
);

// Its policy holds Triage, so it still needs one.
const BoardLive = Board.layer(IssueWorkLive).pipe(
  Layer.provide(DomainCloudflare.layerDurableObjects()),
);

const TriageSessions = AICloudflare.layerDurableObjects(
  TriageLive.pipe(Layer.provide(Layer.mergeAll(Agents, BoardLive))),
);

const Live = BoardLive.pipe(Layer.provideMerge(TriageSessions));
```

Provide `Live` to the Worker, and register `DomainCloudflare.providers()` in the Stack. The model needs the process and the process needs the model: the host closes that loop, so no thunk and no second build of the model is needed. The prose's Layer is built again inside each session's object, so the harness and its storage belong to that one session.

More: [Host the process](https://alchemy.run/ai/hosting#host-the-process), [One object for each session](https://alchemy.run/ai/hosting#one-object-for-each-session).

## Reach a session

Anything given the hosted process holds the client: a policy, a saga, a Worker. Each call goes to the session's object.

```typescript
const triage = yield* Triage;

yield* triage.get(issueId).send(`The issue is ${issueId}.`, { requestId: "start" });
const reply = yield* triage.get(issueId).prompt("What did you find?");
```

More: [Reach a session](https://alchemy.run/ai/hosting#reach-a-session).

## Run it in memory

`Domain.InMemory` hosts the model in one process and `AI.layerInMemory` hosts the process beside it. `AI.scripted` plays a process in place of a model: it stores each message, runs your function as the turn, and stores its answer.

```typescript
const TriagePlayed = AI.scripted(
  Triage,
  Effect.gen(function* () {
    const issues = yield* Issue;
    return Effect.fn(function* ({ key }: AI.Turn) {
      yield* issues.send(new LabelIssue({ issueId: IssueId.make(key), label: "bug" }));
      return "Labeled bug.";
    }, Effect.orDie);
  }),
);

const BoardInMemory = Board.layer(IssueWorkLive).pipe(Layer.provide(Domain.InMemory));

const TriageInMemory = AI.layerInMemory(TriagePlayed.pipe(Layer.provide(BoardInMemory)));

const Live = BoardInMemory.pipe(Layer.provideMerge(TriageInMemory));
```

More: [Run it in memory](https://alchemy.run/ai/hosting#run-it-in-memory).

## Without a host

A process's Layer runs its sessions wherever it is built: yield the process in a Durable Object you write, and its sessions live in that object's storage. `get` is then a local lookup, and the session's live `events()` can be read there. Use it only when a session belongs to something that is already an object of yours.

More: [Without a host](https://alchemy.run/ai/hosting#without-a-host).

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
const session = triage.get(String(issue));

const { status, queued } = yield* session.status;
const page = yield* session.history({ after, take: 50 });
```

Each item is a message, the tools an answer called, or a tool's result. Both work from outside a hosted session's object; ask again with the `seq` of the last item to read only what is new. A hosted session's live `events()` stays in its object.

More: [Read the transcript](https://alchemy.run/ai/processes#read-the-transcript), [Watch a session](https://alchemy.run/ai/processes#watch-a-session).

## Connect a front end

A page reads sessions through the Domain model, never from a session. See [front-end.md](front-end.md).

More: [Connect a front end](https://alchemy.run/ai/front-end).
