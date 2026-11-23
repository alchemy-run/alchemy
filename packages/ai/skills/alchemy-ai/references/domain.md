# Connecting a Domain model

## Mention commands and views through the model

A model's commands, aggregates and views are members of its class.

```typescript
// src/Assistant.process.ts
import * as AI from "@alchemy.run/ai";
import { Bank } from "./Bank/Bank.model.ts";

export class Assistant extends AI.Process<Assistant>()("Assistant", {
  description: "Help one customer with their account.",
})`
  Take a deposit with ${Bank.DepositMoney}. Pay money out with ${Bank.WithdrawMoney}.
  Read the balance with ${Bank.AccountSummary}.
` {}
```

Each is a tool (`Bank_DepositMoney_send`, `Bank_AccountSummary_get`). The process requires the hosted model: provide `Bank.layer(...)` where it runs. Nothing unmentioned is reachable. `Bank.Account` is every command the aggregate takes; prefer single commands.

More: [Mention a command or a view](https://alchemy.run/ai/domain#mention-a-command-or-a-view).

## Say who a session acts as

A middleware that provides request context (who is calling) is answered by `as`. The types require it.

```typescript
// in the Durable Object that runs the session
chat: Effect.fn(function* (customer: Actor, text: string) {
  yield* assistant.start(customer.customerId, {}, { as: CurrentActor.context(customer) });
  const reply = yield* assistant.get(customer.customerId).prompt(text);
  return reply.text;
}, Effect.orDie),
```

```typescript
// in the Worker: authenticate the person as for any other route
const customer = actorOf(request.headers);
if (customer === undefined) return HttpServerResponse.text("sign in", { status: 401 });
const answer = yield* assistants.getByName(customer.customerId).chat(customer, yield* request.text);
```

`as` is stored beside the session and never shown to the model. The model's own rules (`decide`, `validate`) then apply to the session as to that person.

More: [Say who a session acts as](https://alchemy.run/ai/domain#say-who-a-session-acts-as).

## Answer a middleware that checks something

A middleware that provides nothing (a second factor, a rate limit) needs a Layer where the process runs.

```typescript
/** A session can't pass a second factor, so it may not make a call that needs one. */
const MfaForSessions = Layer.succeed(MfaChallenge, () => Effect.fail(new MfaRequired()));
```

Do not provide the HTTP `Session` Layer there: it would look for a cookie on a session's call.

More: [Answer a middleware that checks something](https://alchemy.run/ai/domain#answer-a-middleware-that-checks-something).

## Prove what a session can't break

State rules on the aggregate and verify them. A proved rule holds for every state and command, whoever sends it.

```typescript
// test/Board.verify.test.ts
const story = Story.make(Board, { layer: IssueWorkLive, stub: [Triager] });

it.effect(
  "no command, from a person or a session, breaks the board's rules",
  () =>
    Verify.model(Board, {
      apis: [BoardApi],
      story,
      require: { proved: ["Issue.OnlyLabelingChangesTheLabel"] },
    }).pipe(Effect.provide(NodeServices.layer)),
  120_000,
);
```

More: [Prove what a session can't break](https://alchemy.run/ai/domain#prove-what-a-session-cant-break), [Verifying models](https://alchemy.run/domain/verifying-models).

## Let the model ask for work

The model declares what it asks for as an external system. A policy calls it; it never names a process and never waits.

```typescript
// src/Board/Triager.external.ts
export class Triager extends Domain.ExternalSystem("Triager", {
  start: { args: { issue: IssueId } },
  tell: { args: { issue: IssueId, text: Schema.String, id: Schema.String } },
}) {}
```

```typescript
// src/Board/IssueWork.policy.ts
export const IssueWorkLive = IssueWork.toLayer(
  Effect.gen(function* () {
    const triager = yield* Triager;
    return Effect.fn(function* ({ source, event }) {
      yield* Match.valueTags(event, {
        IssueReported: () => triager.start({ issue: source.id }),
        IssueCommented: ({ body, commentId }) =>
          triager.tell({ issue: source.id, text: body, id: commentId }),
      });
    });
  }),
);
```

More: [Let a policy ask for the work](https://alchemy.run/ai/domain#let-a-policy-ask-for-the-work).

## Wire the model and the sessions to each other

The session's object hosts the model (so the session can send commands), and the model's policy calls the session's object. Host the model as a function of a handle on the objects.

```typescript
// src/Agents.ts
interface Agent {
  readonly start: (issue: IssueId) => Effect.Effect<void>;
  readonly tell: (issue: IssueId, text: string, id: string) => Effect.Effect<void>;
}
interface Agents {
  readonly getByName: (issue: string) => Agent;
}

const boardOver = <R>(agents: Effect.Effect<Agents, never, R>) =>
  Board.layer(IssueWorkLive).pipe(
    Layer.provide(
      Layer.mergeAll(
        DomainCloudflare.layerDurableObjects(),
        Triager.toLayer(
          Effect.map(agents, (agents) => ({
            start: ({ issue }) => agents.getByName(issue).start(issue),
            tell: ({ issue, text, id }) => agents.getByName(issue).tell(issue, text, id),
          })),
        ),
      ),
    ),
  );

/** Inside an object, the objects are its own namespace. */
const own = Effect.map(
  Cloudflare.DurableObjectScope,
  (self) => self as Cloudflare.DurableObject<Agent>,
);

const Live = Layer.mergeAll(HarnessLive, AI.DefaultModel(Smart), boardOver(own)).pipe(
  Layer.provide(ModelsLive),
);

export default class IssueAgents extends Cloudflare.DurableObject<IssueAgents>()(
  "IssueAgents",
  Effect.gen(function* () {
    const triage = yield* Triage;

    return Effect.gen(function* () {
      // A policy's code has no runtime context: give each method the object's own.
      const runtime = yield* RuntimeContext;
      const here = Effect.provideService(RuntimeContext, runtime);
      return {
        start: (issue) => triage.start(issue, { issue }).pipe(Effect.orDie, here),
        tell: (issue, text, id) =>
          triage
            .get(issue)
            .send(text, { requestId: id })
            .pipe(Effect.catchTag("NotStarted", () => Effect.void), Effect.orDie, here),
      } satisfies Agent;
    });
  }).pipe(Effect.provide(Live)),
) {}

/** The model as the Worker hosts it. */
export const BoardLive = boardOver(IssueAgents);
```

More: [The model and the session need each other](https://alchemy.run/ai/domain#the-model-and-the-session-need-each-other).
