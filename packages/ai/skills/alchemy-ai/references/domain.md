# Connecting a Domain model

## List the process on the model

A process is a member of the model. Declare it by name, and list it beside the aggregates and policies. The model's platform then hosts each session.

```typescript
// src/Bank/Assistant.process.ts
import * as AI from "@alchemy.run/ai";
import { CurrentActor } from "./CurrentActor.ts";

export class Assistant extends AI.Process<Assistant>()("Assistant", { as: [CurrentActor] }) {}
```

```typescript
// src/Bank/Bank.model.ts
export class Bank extends Domain.Model("Bank", () => ({
  aggregates: [Account],
  views: [AccountSummary],
  processes: [Assistant],
})) {}
```

The members are a thunk because the process's prose mentions the model (below): see "Break the cycle with thunks".

`as` on the declaration says what a session must be started as. Leave it out when nothing the prose mentions is behind a middleware.

More: [List the process on the model](https://alchemy.run/ai/domain#list-the-process-on-the-model).

## Mention commands and views through the model

A model's commands, aggregates and views are members of its class. The prose is a Layer, beside the name in the process's file:

```typescript
// src/Bank/Assistant.process.ts
import * as AI from "@alchemy.run/ai";
import { Bank } from "./Bank.model.ts";
import { CurrentActor } from "./CurrentActor.ts";

export class Assistant extends AI.Process<Assistant>()("Assistant", { as: [CurrentActor] }) {}

export const AssistantLive = Assistant.toLayer({
  description: "Help one customer with their account.",
})`
  Take a deposit with ${() => Bank.DepositMoney}. Pay money out with ${() => Bank.WithdrawMoney}.
  Read the balance with ${() => Bank.AccountSummary}.
`;
```

Each is a tool (`Bank_DepositMoney_send`, `Bank_AccountSummary_get`). Give `AssistantLive` to `Bank.layer(...)` with the model's other handlers. Nothing unmentioned is reachable. `Bank.Account` is every command the aggregate takes; prefer single commands.

More: [Mention a command or a view](https://alchemy.run/ai/domain#mention-a-command-or-a-view).

## Break the cycle with thunks

The prose imports the model and the model imports the process: a cycle. Whichever file loads first would read the other's class before it exists. A thunk is read when the declaration is first used, once both have loaded:

- each mention in the prose: `${() => Bank.DepositMoney}`;
- the model's members: `Domain.Model("Bank", () => ({ ... }))`;
- any view that lists the process in `from`: `Domain.View("Busy", () => ({ from: [Assistant], ... }))`.

A declaration's type is the same with a thunk. Use one only to break a cycle: props given directly are checked as the file loads.

More: [Break the cycle with thunks](https://alchemy.run/ai/domain#break-the-cycle-with-thunks), [Break an import cycle](https://alchemy.run/domain/model#break-an-import-cycle).

## Say who a session acts as

A middleware that provides request context (who is calling) is answered by `as`. The types require it.

```typescript
// in the Worker: authenticate the person as for any other route
const customer = actorOf(request.headers);
if (customer === undefined) return HttpServerResponse.text("sign in", { status: 401 });
yield* assistant.start(customer.customerId, { as: CurrentActor.context(customer) });
const reply = yield* assistant.get(customer.customerId).prompt(yield* request.text);
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

State rules on the aggregate and verify them. A proved rule holds for every state and command, whoever sends it. `AI.scripted` plays the process in the story; one that does nothing is enough, since the prover sends a session's commands itself.

```typescript
// test/Board.verify.test.ts
const TriageIdle = AI.scripted(Triage, Effect.succeed(() => Effect.succeed("")));
const story = Story.make(Board, { layer: Layer.mergeAll(IssueWorkLive, TriageIdle) });

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

## Let a policy hand it work

A policy decides when there is work, and holds the process's client like any other member's. It never waits: `send` returns once the message is stored. Use the id of what the session works on as its key, and a `requestId`, since a policy can run twice for one event.

```typescript
// src/Board/IssueWork.policy.ts
export const IssueWorkLive = IssueWork.toLayer(
  Effect.gen(function* () {
    const triage = yield* Triage;
    return Effect.fn(function* ({ source, event }) {
      const session = triage.get(source.id);
      yield* Match.valueTags(event, {
        IssueReported: () =>
          session.send(`The issue is ${source.id}.`, { requestId: "start" }),
        IssueCommented: ({ body, commentId }) => session.send(body, { requestId: commentId }),
      }).pipe(Effect.orDie);
    });
  }),
);
```

A saga holds the client the same way, and may `prompt` inside an activity when a step needs the answer. Do not put a `Domain.ExternalSystem` between a model and its own process.

More: [Let a policy hand it work](https://alchemy.run/ai/domain#let-a-policy-hand-it-work).

## Follow what a session does through the model

The model records each process it lists as a view named after it, keyed by the session. Nothing is declared for it. Its state is `{ status: "idle" | "working", queued }`; each event, `<Process>Activity`, carries the status, the queue and the transcript items stored since the last one. The session's own object sends each batch, through an eviction too.

An Api serves it like any view (`Api.Triage.watch`, `Api.Triage.events`). A view of the model follows it by listing the process in `from` and handling `TriageActivity`:

```typescript
// src/Board/IssueList.view.ts
export class IssueList extends Domain.View("IssueList", () => ({
  from: [Issue, Triage],
  key: Schema.String,
  keyOf: { IssueReported: () => ALL, TriageActivity: () => ALL },
  // ...
})) {}
```

More: [Follow what a session does](https://alchemy.run/ai/domain#follow-what-a-session-does).

## Keep entry points thin

A webhook, a queue or a form turns what happened into a command and stops. It never starts a session: the model's policy does.

```typescript
// src/GitHubIssues.ts
yield* issues.send(
  new ReportIssue({ issueId, title: payload.issue.title, body: payload.issue.body ?? "" }),
  { commandId: event.id },
);
```

More: [The outside world comes in as commands](https://alchemy.run/ai/domain#the-outside-world-comes-in-as-commands).
