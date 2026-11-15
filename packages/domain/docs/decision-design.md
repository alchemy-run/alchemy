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

### Durable Objects: two-phase commit with no coordinator

Each instance is an object with its own storage, so nothing can lock two at once. `src/TwoPhase.ts` commits across them, and whoever sends the command runs it:

1. **Read** every instance's state and version, and decide.
2. **Prepare** each instance, in stream order. The instance checks that it still has the version it was read at and stores the decision's events as an *intent*. While it holds one it takes no other command.
3. **Commit the first instance**, the *primary*. That single local transaction is the commit point. It turns the primary's intent into events and stores the receipt under the command id.
4. **Commit the others.** Each turns its intent into events, state and deliveries, in one local transaction, as an ordinary command would.

The sender may die at any step. Recovery needs no coordinator object, because the outcome always lives on the primary:

- An instance holding an intent asks the primary. *Committed*: it applies its intent. *Aborted*: it drops it. It asks when its next command arrives, and on a durable callback one second after the deadline, so an instance nobody touches again still settles.
- The primary judges the deadline, and only the primary, on its own clock. An intent that outlives it (5 seconds) is aborted, and the abort is recorded, so a commit that arrives late finds nothing to commit. Clocks decide when a stuck instance is freed. They never decide what happened.
- The primary keeps a committed outcome until every other instance has acknowledged applying it.

Why it is safe:

- **All or nothing.** Before the primary commits, every instance holds an intent or nothing, and an intent is invisible. After it, every other instance either has applied or holds the intent and can learn the outcome. No path applies some and drops others.
- **No lost update.** Prepare checks the version under the instance's exclusive section and holds the instance until the intent settles, so nothing commits between the check and the apply.
- **No deadlock.** Intents are taken in stream order. Two decisions that share instances meet at the first one they share, where the second is told the instance is busy before it holds anything the first needs.
- **Rejections come from a real state.** A rejection commits nothing, but it must not come from states that never existed together. After deciding, the versions are read again, and if none moved, the states did exist together at one moment. No lock is taken.
- **Exactly once.** The primary stores the receipt in its commit transaction. A send with a command id it has committed gets that receipt, from the first read or from prepare.
- **Idempotent calls.** Every call between objects may be retried in transit. A repeated prepare for the same attempt answers the same. A prepare that arrives after its attempt was aborted by its deadline finds the abort. A commit asked twice answers `Committed` twice.
- **A lost answer can't split a decision.** The sender may commit the primary and never learn that it did. When it then gives up and tells the others to abort, they don't take its word: an instance that isn't the primary asks the primary first, and applies its intent if the decision committed.

What it costs:

- **Calls.** A decision over N instances makes about 3N calls (read, prepare, commit) and one acknowledgement. A decision over one instance still goes through them.
- **Writes.** Each prepare stores the intent and schedules the durable callback that settles it if nobody else does. Each commit cancels it. That is several more storage rows per instance than an aggregate's own command writes.
- **A held instance waits.** Commands to an instance that holds an intent wait: milliseconds normally, up to the deadline if the sender died.
- **Contention retries.** A decision that meets a busy instance, or one that changed, starts over, with backoff, for about 20 seconds. After that it dies with a defect that says so. A hot instance serializes every decision that reads it, which is inherent in the rule.

### Pluggable

`TwoPhase.DecisionCommit` is a `Context.Reference` holding the strategy `makePlatform` uses. Provide another to the platform's Layer to replace two-phase commit.

The one worth building next is for Effect Cluster, whose instances share one Postgres: a decision can be a single database transaction that locks each instance's row. It needs aggregate commits to take the same row lock, so it is its own change.

## What stays the same

- Events belong to one aggregate instance's stream. Views, projections, policies, streams, backfill and catch-up see a decision's events as any others.
- Envelopes carry the decision's command id and correlation id, and one commit time for every event.
- Stories: `Story.when(Transfer, command)`, then `Story.then` on each instance. A story that leaves a recorded event unasserted fails, as for any command.
- Sagas and policies remain for work that takes time or calls an external system.

## Tests

- `test/Domain/Decision.test.ts`: the semantics, in memory.
- `test/Domain/DecisionDurableObjects.test.ts`: the two-phase commit on in-process objects, including the sender dying before the second prepare, after every prepare, and after the commit point, and an instance that settles with no further command. Every case runs twice: as Cloudflare runs an instance, and behind the input gate Rivet and Effect Cluster run storage behind.
- `test/Domain/DecisionApi.test.ts`: stories, the typed client, plain HTTP, the CLI and MCP tools.
- `test/Domain/conformance`: five cases every platform runs over HTTP, on Cloudflare (local workerd), Rivet and Effect Cluster (Docker).
- `packages/domain/test/types/Decision.ts`: what is a type error.
- `examples/cloudflare-domain`: the bank registers a customer under a unique username with a decision.

## Not done

- **Scheduling.** A decision's command can't be scheduled with `schedule`.
- **`predict`.** An aggregate predicts its own commands for optimistic updates. A decision has no `predict` yet: it would need each instance's state on the client.
- **A late prepare.** A prepare that arrives after its attempt was undone by its sender (not by the deadline) is accepted, and holds the instance until the deadline frees it. It can't commit, so only liveness is affected.
- **Keyed logs.** A coarser partition (one log per tenant) could decide with tags and queries inside itself, DCB-style, and take part in a decision as one participant. `DecisionKit` already treats participants by address, version and events, so it would fit the same commit.
