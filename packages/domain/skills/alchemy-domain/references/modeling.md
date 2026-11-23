# Breaking requirements into building blocks

Work from the language of the business. Write the requirements as sentences, then mark each one.

## 1. List the facts

Every past-tense statement the business cares about is an event. "The customer withdrew money" becomes `MoneyWithdrawn { amount, balanceAfter }`. An event carries what changed and what a reader needs (here `balanceAfter`, so views don't recompute). Name it from the business's point of view, never as a CRUD verb (`AccountUpdated` is a smell).

More: [Event](https://alchemy.run/domain/event).

## 2. Find the decisions

Each event is produced by a command that someone asks for: `WithdrawMoney { amount }`. Ask what can refuse it. Each answer is a rejection carrying the evidence (`InsufficientFunds { balance, requested }`, `DailyLimitExceeded { remaining }`). Name commands `<Verb><Noun>`.

More: [Command](https://alchemy.run/domain/command).

## 3. Draw consistency boundaries

Group the commands by what must be checked together in one transaction. That group is an aggregate, keyed by an id (`Account` keyed by `AccountId`). Its state holds only what its decisions need. Keep aggregates small: one instance is one writer, and it decides from its own state alone.

When a rule spans instances, pick one of these:

- **Decision.** A command answered at once across several instances: `RegisterCustomer` reads the customer and the username and records on both, or refuses. Use it when nothing has to wait and nothing outside the model is called.
- **Invariant-shaped aggregate.** Uniqueness of a username across customers becomes `UsernameClaim`, keyed by the username, which every registration's decision reads. Two that ask for one name read the same instance, and exactly one wins.
- **Saga.** A process that takes time, waits for a decision, or calls an external system runs as steps, each undone by a compensation when a later one fails.
- **Deadline.** A process that waits for a decision schedules a command that can't be rejected (`ExpireTransfer`), on the same aggregate as the decision, so exactly one of approve and expire wins.

More: [Aggregate](https://alchemy.run/domain/aggregate), [Decision](https://alchemy.run/domain/decision), [Unique values](https://alchemy.run/domain/unique-values), [Domain Model: Each command goes to one instance](https://alchemy.run/domain/model#each-command-goes-to-one-instance).

## 4. Answer the questions

Every screen or report is a view, keyed by what it's about: `AccountSummary` keyed by account, `CustomerDashboard` keyed by customer. A view folds events from one or more aggregates (or other views) into state. It can also emit its own events (`Statement` turns six money events into `StatementLine`). Route one event to several keys with named routes in `keyOf`, e.g. a transfer shows on both accounts.

A view is a security boundary. Its `validate` judges every read from who is asking. Make a separate view per audience instead of filtering by caller.

A question across keys (an account's ledger, paged; "withdrawals over 1,000 across all accounts, largest first") is not a view. A projection writes it to a store you own, and a query serves it: `AccountLedger` reads the `Ledger` projection's table. Its input holds the filters and sort orders it supports, and its handler judges the caller and scopes the rows it reads.

More: [View](https://alchemy.run/domain/view).

## 5. Find the reactions

"Whenever X, do Y" is a policy, listening to an aggregate or a view. "When a customer registers, open their main account" is `MainAccountProvisioning` on `CustomerRegistered`, sending `OpenAccount`. A policy has no session, so it provides the request context its commands need (e.g. `CurrentActor` = system).

More: [Policy](https://alchemy.run/domain/policy).

## 6. Find the processes

A reaction with several steps, waits, or undo is a saga: an Effect workflow keyed by the aggregate it's about. "Move money: debit, credit; if the credit fails, refund; large transfers wait for approval" is `ExecuteTransfer`. A policy starts it on `TransferRequested` and signals it on `TransferApproved`. Each step is an `Activity` that sends one command. `withCompensation` undoes a step, and `DurableDeferred` waits for a signal.

More: [Saga](https://alchemy.run/domain/saga).

## 7. Find what's outside

Calls to other systems are external systems: typed operations declared in the domain and implemented in the server (`FraudCheck.score`, `Payments.refund`). Writes to stores outside the model are projections (`Ledger` writes rows through a `LedgerStore` port), and queries read them back for clients (`AccountLedger`). A per-key log that clients read is a stream (`AccountCard`), written by a projection.

More: [External System](https://alchemy.run/domain/external-system).

## 8. Decide who sees what

Group commands and reads into Apis by audience (`CustomerApi`, `SupportApi`). Middleware authenticates (`Session` provides `CurrentActor`; `MfaChallenge` guards sensitive commands). Each command's `decide` and each view's or stream's `validate` (on its Layer) authorizes against the current state. A query's handler authorizes the request, failing with a declared rejection, and reads only the rows the caller may see.

More: [Views as security boundaries](https://alchemy.run/domain/view-security).

## Patterns for history that grows or has to change

Pick by what the record is. None of these is the default: an instance that stays small needs nothing.

**Keeping history small**

- **A book per period (closing the books).** The record has periods the business names. Put the period in the aggregate's id (`a-1.2026-01`). The closing event carries the balance and the next id (`BookClosed { balance, next }`), and a policy opens the next instance with it (`OpenBook { broughtForward }`, which adds to what the book holds, so order doesn't matter). A view keyed by the book is that period's statement. Callers work out the current id from the date.
- **Remove a closed period** once it no longer has to be kept: `Domain.Rewrite(name, { of: Book, delete: true })`. Later periods are untouched.
- **Roll up one instance.** No periods, and the state is worth keeping: a `Domain.Compaction` with `{ after: { events: n } }` on its Layer, or `compact` called from a policy at a moment that means something (a book closing).
- **Archive or discard.** The compaction's Layer is given the replaced events: write them to a bucket or a warehouse, or do nothing and let them go.

More: [Closing the books](https://alchemy.run/domain/closing-the-books), [Compaction](https://alchemy.run/domain/compaction).

**Erasing personal data**

- **Keep it out of the events.** Record an id, and keep what it identifies in a store of your own. Erasing is one delete there. Prefer this while the events are still being designed.
- **Rewrite.** The data is already in the events: a `Domain.Rewrite` per aggregate that holds it, each projection it reaches with a `rewrite` handler, and a saga that runs them and waits on `rewritten`.
- **Remove the instance.** Nothing in it has to stay: a rewrite with `delete: true`.
- **Encrypt before recording.** The record must never change, or copies leave the model: the server encrypts the field with a per-person key from its own store before sending the command, reads decrypt, and deleting the key erases. Only for data the model carries and never decides on.

Don't compact an aggregate whose events hold personal data: a rewrite can't reach the copies views kept of events a compaction removed.

More: [Erasing personal data](https://alchemy.run/domain/erasing-personal-data), [Erasing personal data: Erase before you compact](https://alchemy.run/domain/erasing-personal-data#erase-before-you-compact), [Rewrite](https://alchemy.run/domain/rewrite).

## Smells

- A command that touches two aggregates. Split it, and connect the parts with a policy or a saga.
- A view that filters by caller. Make one view per audience.
- A hand-written route that reads a projection's store. Declare a query: it gets the middleware, typed rejections, paging, `atLeast` and stories for free.
- A policy that waits for a result. Use a saga, and react to the events it records.
- An event named after a field change (`BalanceSet`). Name the business fact instead.
- A rejection without evidence. Add the fields a client needs to explain it.
