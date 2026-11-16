# Design: `Domain.Decision`

Status: implemented on the in-memory platform and on every Durable Object host (Cloudflare, Rivet, Effect Cluster). What isn't done is listed at the end.

## The problem

An aggregate instance decides alone. It takes one command at a time, and its events, state and receipt commit together. That makes one instance a consistency boundary, and nothing spans two.

A rule that involves two instances is therefore written as messages between them. The bank example registers a customer under a unique username with:

- a `UsernameClaim` aggregate keyed by the name,
- a `UsernameReservation` policy that claims the name, then confirms or rejects the registration,
- three extra commands (`ClaimUsername`, `ConfirmRegistration`, `RejectRegistration`) and two extra events,
- a `Pending` state on `Customer` for the time in between.

The caller never learns that the name was taken: `RegisterCustomer` succeeds, and the rejection arrives later as an event. A transfer between two accounts needs a saga with a compensation for the same reason.

Some of these processes take time, and a saga is right for them. But many are one rule that should be decided once, answered at once, and committed entirely or not at all.

## What we looked at

**Dynamic Consistency Boundaries.** DCB drops streams: events go into one log, each carrying tags (`customer:c-1`, `username:sam`). A command reads the events matching a query, decides, and appends on the condition that nothing matching the query was appended since. The boundary is chosen per command.

Every DCB store we found is one log on one database. They make the conditional append atomic with a table lock, per-tag advisory locks, serializable isolation, or per-tag marker rows. One implementer's summary: when boundaries span partitions, "you've shipped a distributed transaction". The global position those stores hand out is also the part that breaks when distributed: positions commit out of order, and a reader that checkpoints past a gap loses the event that fills it later.

Domain has no single log. Every aggregate instance, view key and projection key is its own single-writer object, and that is why it scales on Durable Objects. Views, projections, policies, backfill and catch-up all route by `(source stream, seq)`.

**Multi-stream append.** The stores that scale DCB detect conflicts with a version per tag, which is an expected version per stream by another name. The same guarantee, stated in Domain's terms: append to several streams atomically, each on the condition that it still has the version it was read at.

That is what `Decision` is. Events keep belonging to one aggregate instance's stream, with its own sequence numbers, so nothing downstream changes.

## The primitive

A decision implements one command across several aggregate instances.

```ts
export class TransferMoney extends Domain.Command("TransferMoney", {
  input: { from: AccountId, to: AccountId, amount: Schema.Int },
  events: [TransferSent, TransferReceived],
  rejects: [InsufficientFunds],
}) {}

export class Transfer extends Domain.Decision(TransferMoney, {
  reads: (cmd) => ({ from: Account.ref(cmd.from), to: Account.ref(cmd.to) }),
  decide: ({ from, to }, cmd) =>
    cmd.amount > from.state.balance
      ? new InsufficientFunds()
      : [
          from.record(new TransferSent({ amount: cmd.amount })),
          to.record(new TransferReceived({ amount: cmd.amount })),
        ],
}) {}
```

- **`reads`** names the instances the command involves. It is a pure function of the command, so the set is known before anything is read.
- **`decide`** sees every instance's state and version together and returns events, each recorded on one instance with that instance's `record`, or a rejection. It is pure, or an `Effect.fn` that reads only what the command's middleware provides, exactly like an aggregate's `decide`.
- **A decision has no state.** Each instance folds what is recorded on it with its own `evolve`.

Three things change around it:

- **A command has no `target`.** Its input names every instance it involves. An aggregate that implements it says which field is its instance, with `keyOf`; a decision names them in `reads`. So an implementation can move from an aggregate to a decision without changing the command or its callers.
- **An aggregate lists `events` it folds but doesn't decide.** `evolve` covers them. An aggregate that only takes part in decisions leaves out `commands` and `decide`.
- **A model lists `decisions`.** Every command has exactly one implementation. A second one is a type error on its entry in the model (`"OpenBoth is already implemented by Door"`) and a `DefinitionError` (`ImplementedTwice`) from `Domain.verify`.

### Why the command stays separate

A decision could have declared its own input and rejections. Keeping the command gives four things:

- Clients import the command without the `decide` code or the aggregates it reads.
- An Api lists commands uniformly, whichever way they are implemented.
- An implementation can move from one aggregate to a decision without changing the contract.
- The model can check that every command is implemented once.

### What a caller sees

`yield* Transfer` gives a client with `send(command, options)`. An Api client method takes the input, as for any command: `bank.TransferMoney({ from, to, amount })`. The receipt names every stream the decision read:

```ts
interface Receipt<Ev, Reply> {
  readonly commits: ReadonlyArray<{ readonly stream: string; readonly version: number }>;
  readonly events: ReadonlyArray<Ev>;
  readonly reply: Reply;
}
```

Each entry of `commits` is what a read takes as `atLeast`.

Over an Api every command answers the same shape, whichever way it is implemented: `{ reply, stream, version, commits }`. `stream` and `version` are the first commit, so a command an aggregate implements reads as it always did.

## Atomicity

The contract a platform implements is one method:

```ts
interface DecisionStore {
  readonly send: (command: Json, meta: SendMeta) => Effect.Effect<DecisionResult>;
}
```

The kernel hands it a `DecisionKit`: `reads(command)` gives the instances in stream order, and `decide(input)` runs `decide` against the states it is given and returns a rejection or one write per instance. How the reads and writes become atomic is the platform's.

### In memory

One process. A decision takes the lock of every aggregate type it reads, in name order, reads, decides, and records before it lets go.

### Durable Objects: two-phase commit, driven by the first instance

Each instance is an object with its own storage, so nothing can lock two at once. `src/TwoPhase.ts` commits across them. The first instance the command reads, in stream order, is the *primary*. The sender makes one call, `txDecide`, to the primary's object, and the primary drives the rest:

1. **Read** its own state and every other instance's, and decide.
2. **Hold** the whole plan in its own storage: its events, each other instance's events and read version, and the receipt. It schedules a durable wake-up in the same step.
3. **Prepare** each other instance. The instance checks that it still has the version it was read at and stores its events as an *intent*. While it holds one it takes no other command.
4. **Commit** itself. One local transaction turns its part of the plan into events, stores the receipt under the command id, and records `Committed` with the list of instances still to be told. This is the commit point.
5. **Deliver** the outcome. Each other instance turns its intent into events, state and deliveries in one local transaction, as an ordinary command would. The primary removes it from the list, and forgets the outcome when the list is empty.

No clock decides an outcome. An earlier version had whoever sent the command drive these steps, and a deadline on the primary to free instances when that sender died. A sender is a Worker request and can vanish at any await, so the deadline was the only way to end an attempt. Now the driver's state is durable, so an attempt is ended by a fact:

- **Commit**: every other instance answered `Prepared`.
- **Abort**: one answered `Conflict` (it changed) or `Busy` (another decision holds it), or couldn't be reached after a few tries. The primary releases itself and records `Aborted` in one transaction, then tells the others.

Recovery is the same steps again, because everything but the commit and the abort is idempotent:

- `prepare` for an attempt an instance already holds answers `Prepared`.
- `commit` on the primary answers `Committed` when it already committed, and `Gone` when the attempt ended some other way. `abort` answers what became of it.
- Delivering an outcome to an instance that has no such intent does nothing.

The wake-up runs `TwoPhase.finish` on the plan in storage when the plan has been held for two seconds, and redelivers any outcome somebody hasn't acknowledged. A command or a read that finds the primary held that long does the same first. If the original driver is in fact still alive, the two overlap harmlessly: they prepare the same instances with the same attempt id, and whichever reaches the commit or the abort first decides, in the primary's exclusive section. The two seconds only choose when to help. They can't abort anything.

An instance told an outcome by the primary acts on it without asking, because the primary records an outcome before it tells anyone. An instance that holds an intent and hears nothing asks the primary (`txOutcome`), on its next command and on a wake-up of its own. The primary answers `Pending` while it holds the plan, then the recorded outcome, and `Aborted` for an attempt it has no trace of. That last answer is safe because an outcome is forgotten only once every instance has acknowledged it, so an instance still asking holds a stray copy: a prepare that arrived after its attempt ended.

Why it is safe:

- **All or nothing.** Before the primary commits, every instance holds an intent or nothing, and an intent is invisible. After it, every other instance either has applied or holds the intent, and the primary keeps the outcome until it has applied.
- **One place decides.** Commit and abort both happen in the primary's exclusive section and both remove the plan, so exactly one of them wins, whoever asks and however often.
- **No lost update.** Prepare checks the version under the instance's exclusive section and holds the instance until the intent settles, so nothing commits between the check and the apply.
- **No deadlock.** The primary is the first instance in stream order, so it only prepares instances after itself, and nothing waits while holding: an attempt that meets a held instance aborts, releases everything, and retries after a pause.
- **Rejections come from a real state.** A rejection commits nothing, but it must not come from states that never existed together. After deciding, the versions are read again, and if none moved, the states did exist together at one moment. No lock is taken.
- **Exactly once.** The primary stores the receipt in its commit transaction. A send with a command id it has committed gets that receipt.
- **The sender doesn't matter.** Once the plan is held, the decision finishes whether or not the sender is still there. It only loses the answer, and a resend with the same command id returns it.
- **No callbacks into a waiting object.** The primary calls other instances only outside its exclusive section, and they never need to call it back to act on what it tells them.

What it costs:

- **Calls.** One from the sender, then about three per other instance (read, prepare, commit).
- **Writes.** The primary stores the plan and a wake-up, then the outcome. Each other instance stores its intent and a wake-up. Each cancels its wake-up when it settles.
- **A held instance waits.** Commands to an instance that holds an intent wait: milliseconds normally, about two seconds when the driver stopped.
- **An unreachable primary blocks.** Instances it prepared stay held until its object answers. Their commands fail after about 13 seconds and succeed once it is back. This is two-phase commit's blocking case. It affects availability, not correctness.
- **Contention retries.** An attempt that meets a busy or changed instance starts over, with backoff, for about 20 seconds, inside the primary's call. After that it dies with a defect that says so. A hot instance serializes every decision that reads it, which is inherent in the rule.
- **`decide` runs in the primary's object.** The code that hosts an aggregate must also host the decisions that read it first; an object on older code answers with a defect, and the sender retries through the rollout.

### Pluggable

`TwoPhase.DecisionCommit` is a `Context.Reference` holding the strategy `makePlatform` uses. A strategy is given the command and a way to hand it to an instance as its primary. Provide another to the platform's Layer to replace two-phase commit.

The one worth building next is for Effect Cluster, whose instances share one Postgres: a decision can be a single database transaction that locks each instance's row. It needs aggregate commits to take the same row lock, so it is its own change.

## What stays the same

- Events belong to one aggregate instance's stream. Views, projections, policies, streams, backfill and catch-up see a decision's events as any others.
- Envelopes carry the decision's command id and correlation id, and one commit time for every event.
- Stories: `Story.when(Transfer, command)`, then `Story.then` on each instance. A story that leaves a recorded event unasserted fails, as for any command.
- Sagas and policies remain for work that takes time or calls an external system.

## Tests

- `test/Domain/Decision.test.ts`: the semantics, in memory.
- `test/Domain/DecisionDurableObjects.test.ts`: the two-phase commit on in-process objects. Interrupted cases: the sender hanging up, the primary stopping before the second prepare and after the commit, every object evicted midway, an unreachable instance, a stray intent, and a lost commit answer. Every case runs twice: as Cloudflare runs an instance, and behind the input gate Rivet and Effect Cluster run storage behind.
- `test/Domain/DecisionApi.test.ts`: stories, the typed client, plain HTTP, the CLI and MCP tools.
- `test/Domain/conformance`: five cases every platform runs over HTTP, on Cloudflare (local workerd), Rivet and Effect Cluster (Docker).
- `packages/domain/test/types/Decision.ts`: what is a type error.
- `examples/cloudflare-domain`: the bank registers a customer under a unique username with a decision.

## Not done

- **Scheduling.** A decision's command can't be scheduled with `schedule`.
- **`predict`.** An aggregate predicts its own commands for optimistic updates. A decision has no `predict` yet: it would need each instance's state on the client.
- **Keyed logs.** A coarser partition (one log per tenant) could decide with tags and queries inside itself, DCB-style, and take part in a decision as one participant. `DecisionKit` already treats participants by address, version and events, so it would fit the same commit.
