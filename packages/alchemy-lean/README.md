# alchemy-lean

Alchemy in [Lean 4](https://lean-lang.org): a domain model, the stack that hosts it, and proofs about both, in one language. A rule is a theorem, so the file does not compile unless the rule holds. A prototype, not a published package.

```sh
curl https://elan.lean-lang.org/elan-init.sh -sSf | sh
lake build        # proves every theorem and runs every story
```

`Alchemy.lean` is the library's entry point, like an `index.ts`: it only imports the modules, so that `import Alchemy` gives a file all of them. A program, the counterpart of `alchemy.run.ts`, is a file under `examples/`. Start with `examples/Shop.lean`.

## A domain model

Each aggregate is a namespace with its `Command`, `Event`, `Rejection` and `State` types and its `key`, `decide` and `evolve` functions. One `model` block declares the rest:

```lean
model Bank where
  aggregate Account

  call screen (account : String) (amount : Nat) : Screening
  call wire (payout account : String) (amount : Nat) : WireResult

  -- decided across two accounts at once: both record it, or neither does
  decision Transfer (TransferRequest) : TransferRefused
    | accounts, ⟨source, destination, amount⟩ =>
      if (Account.of accounts source).balance < amount then
        .error (.insufficientFunds (Account.of accounts source).balance amount)
      else .ok [
        Account.record source (.transferredOut amount),
        Account.record destination (.transferredIn amount)]

  -- steps, with an undo if a later one fails
  saga Payout (PayoutRequest) (Unit) : PayoutFailed
    | payout, ⟨account, amount⟩ => do
      Account.must (.withdraw account amount) fun _ => .refused
      Account.undoWith (.deposit account amount)
      match ← wire payout account amount with
      | .sent => pure ()
      | .bounced => failWith .bounced

  policy Compliance on Account
    | id, .deposited amount => do
      if amount ≥ 10000 then
        match ← screen id amount with
        | .flagged reason => Account.send (.freeze id reason)
        | .clear => pure ()

  view Holdings on Account : Int := 0
    | total, .deposited amount => total + amount
    | total, .withdrawn amount => total - amount

  projection Statement on Account : String × String × Nat
    | id, .deposited amount => [(id, "deposit", amount)]
```

The block covers aggregates keyed by a string, outside calls, policies, decisions, one saga, a view that folds one value over one aggregate, and projections. Keyed views, streams, queries and actors are written without it, as `examples/Bank` does.

## What you prove about it

**Behaviour of one aggregate.** Given these events, when this command arrives, then this happens, for every id and amount:

```lean
theorem anOverdraftIsRefused (id owner : String) (held amount : Nat) (tooMuch : held < amount) :
    Account.decide (Account.after [.opened owner, .deposited held]) (.withdraw id amount)
      = .error (.insufficientFunds held amount)
```

**An invariant.** A fact about the state that no accepted command breaks. `aggregate_rule` takes each command and each branch of `decide`:

```lean
def Balanced (s : Account.State) : Prop := s.balance + s.withdrawn = s.deposited

theorem balanced_kept : Account.Keeps Balanced := by
  aggregate_rule [Account.decide, Account.evolve, Balanced]
```

**In every world the model can reach, and as deployed.** `Account.always` and `Account.deployed` come with the model. Whatever callers send, whatever the outside systems answer, in any order of delivery, with any event delivered twice:

```lean
theorem everyAccountBalanced (w : World Signature) (reach : Bank.Reachable w) (id : String) :
    Balanced (w.state .Account id) :=
  Account.always (by simp [Balanced]) balanced_kept w reach id transfer_balanced
```

**Across aggregates.** A rule about the whole record, proved by showing no command and no decision breaks it:

```lean
theorem noTransferCreatesMoney (w : World Signature) (reach : Bank.Reachable w) :
    Conserved w.toRecorded
```

**Behaviour of a whole flow.** A scenario is a list of moves: commands sent, decisions made, outside calls answered, time passing. `behaviour` proves the claim by running the model with its variables left as they are:

```lean
def aPayoutBounces (id owner payout : String) (held amount : Nat) : List (Model.Move Bank) := [
  .send ⟨.Account, (), .open id owner⟩,
  .send ⟨.Account, (), .deposit id held⟩,
  .send ⟨.Account, (), .requestPayout id payout amount⟩,
  .answer (.wire payout id amount) .bounced]

theorem aBouncedPayoutIsRefunded (id owner payout : String) (held amount : Nat)
    (some : amount ≠ 0) (enough : amount ≤ held) (modest : held < 10000) :
    let bank := Bank.run (aPayoutBounces id owner payout held amount)
    (bank.state .Account id).balance = held ∧ bank.sagas payout = .failed .bounced
```

**Reads.** Each view and projection comes with a theorem that it equals its definition over the log: `Holdings.exact`, `Statement.exact`.

## Stories

A story is a test the compiler runs: one case with real values, every step visible. It can follow the same scenario a theorem is about; `.next` makes the scenario's next move:

```lean
example : Bank.follows (aPayoutBounces "a-1" "Sam" "p-1" 500 200) [
    .next 3,
    .call (.wire "p-1" "a-1" 200),
    .state .Account "a-1"
      { status := .open, owner := "Sam", balance := 300, deposited := 500, withdrawn := 200 },
    .next,
    .saga "p-1" (.failed .bounced),
    .recorded .Account "a-1" [.opened "Sam", .deposited 500, .payoutRequested "p-1" 200,
      .withdrawn 200, .deposited 200]
  ] = true := by decide
```

A story shows the behaviour is the one you meant. A theorem shows it always holds.

## Two models together

A `Link` says which of one model's calls another model answers. What was proved of each holds of both with no new proof, and `behaviour` proves flows across the two (`examples/Linked.lean`):

```lean
def screening : Link Bank Compliance where
  ask
    | .screen account amount => some ⟨.Watch, (), .assess account amount⟩
    | .wire .. => none
  reply …

theorem aReportableDepositFreezesTheAccount (id owner : String) (amount : Nat)
    (reportable : amount ≥ 50000) :
    let both := screening.run [
      .send ⟨.Account, (), .open id owner⟩,
      .send ⟨.Account, (), .deposit id amount⟩]
    (both.1.state .Account id).status = .frozen "over the reporting threshold" ∧
      both.2.state .Watch id = { assessed := 1, flagged := 1 }
```

## A stack

A host is a `do` block. A binding is a step that gives a client and adds its grant to the host's role. Consuming a queue is a step that registers the host as the consumer. Nobody writes the role (`examples/Shop.lean`):

```lean
def Api (orders : Bucket) (shipments : Queue) : Construct Kind Function :=
  Lambda.Function "Api" { url := true } do
    let journal ← S3.Journal orders
    let queue ← SQS.SendMessage shipments
    return route (served.host journal (outside queue))

def Warehouse (orders : Bucket) (shipments : Queue) : Construct Kind Function :=
  Lambda.Function "Warehouse" {} do
    let slips ← S3.PutObject orders ["packed"]
    SQS.consume shipments fun shipment => do …
    return fun _ => return { status := 204 }

def ShopStack : Stack Kind Outputs where
  name := "Shop"
  body := do
    let orders ← S3.Bucket "Orders"
    let shipments ← SQS.Queue "Shipments"
    let api ← Api orders shipments
    let warehouse ← Warehouse orders shipments
    return { orders, shipments, api, warehouse }
```

`served.host journal …` hosts a domain model: every command and every outside answer is written to the journal before it is applied.

There is a small AWS (S3, SQS, Lambda) and a small Cloudflare (R2, Queues, Workers with `fetch`, typed RPC and `Queues.consume`; `examples/Inbox.lean`). Both run in memory. An engine plans and applies an AWS stack against a model of the control plane.

## What you prove about a stack

**Who can do what**, in the stack's own words. `only`, `nobody`, `never` and `may`, over `S3.writing`, `S3.reading`, `S3.listing`, `SQS.sending`, `SQS.receiving`, `Lambda.invoking`. Each covers every key under its prefix:

```lean
theorem onlyTheApiWritesHistory :
    prod.only [out.api] (S3.writing out.orders ["journal"]) := by
  stack_rule in prod using [out, BucketOp.covers]

theorem theWarehouseReadsNothing :
    prod.never out.warehouse (S3.reading out.orders) := by
  stack_rule in prod using [out, BucketOp.covers]
```

**Least privilege.** Every call a host makes is inside its role, because a call outside it does not type check. And no host holds a grant it never uses; the stories are the runs that show each grant used:

```lean
theorem leastPrivilege : prod.LeastPrivilege InMemory :=
  .of_stories [anOrder] (by native_decide)
```

**Behaviour of a function, for every request.** Given what the bucket holds, when a request arrives, then this is the response and this is what the bucket holds afterwards:

```lean
theorem gettingAnOrder (id : String) (cloud : Memory) :
    (getOrder (theShop le queue) id).eval InMemory cloud
      = (.ok (describe ((shopIn orders cloud).state .Order id)), cloud)
```

These are proved from the laws of the bindings. Each AWS binding states what a call answers and what it does to the cloud (`Alchemy/Cloud/AWSLaws.lean`), and its implementation is proved to keep that law.

**Deploying.** The plan for a fresh account, that a second deploy changes nothing, and that a deploy leaks no resource, against the model of AWS.

## The examples

| File | What it shows |
|---|---|
| `examples/Wallet.lean` | The smallest: one aggregate, one invariant, one story |
| `examples/Accounts.lean` | A bank built up in steps: behaviour, invariants, a transfer across accounts, a saga, stories beside theorems |
| `examples/Linked.lean` | That bank linked to a compliance model |
| `examples/Shop.lean` | A model on an AWS stack, end to end, with access and request theorems |
| `examples/Inbox.lean` | Cloudflare Workers: bindings, a queue consumer, `fetch` and RPC |
| `examples/Jobs.lean` | The earlier style: services, Layers and `Effect` with typed errors |
| `examples/Bank/` | A larger bank, written before the `model` block: keyed views, streams, queries, actors, and proofs that transfers lose no money and always end |

`lake exe bank bank.journal 8787` serves `examples/Bank` over HTTP from one process, kept in a journal file.

## The library

| Path | What it holds |
|---|---|
| `Alchemy/Aggregate.lean`, `Signature.lean`, `Program.lean`, `View.lean`, `Model.lean` | The domain model: aggregates, policies and sagas as data, views, decisions, and every step a model can take |
| `Alchemy/Engine.lean`, `Story.lean`, `Check.lean` | Running a model, stories, and a search for the shortest run that breaks a rule |
| `Alchemy/Syntax.lean` | The `model … where` block |
| `Alchemy/Behaviour.lean` | The `behaviour` tactic |
| `Alchemy/Compose.lean` | `Link`: two models, one answering the other's calls |
| `Alchemy/Cloud/Access.lean`, `Run.lean`, `Graph.lean`, `Host.lean` | Access, code that runs under a role, the resource graph, and a host's block |
| `Alchemy/Cloud/Hosted.lean`, `HostedLaws.lean` | A model run by a host, and the proofs about it |
| `Alchemy/Cloud/Laws.lean`, `AWSLaws.lean`, `AWSJournal.lean` | Stepping through code, the AWS bindings' laws, and the journal on S3 |
| `Alchemy/Cloud/Sim.lean`, `Tactics.lean` | Stories for a stack, least privilege, `access`, `stack_rule`, `aggregate_rule` |
| `Alchemy/Cloud/AWS.lean`, `Cloudflare.lean` | The two small clouds |
| `Alchemy/Cloud/Engine.lean`, `Provider.lean`, `AWSControl.lean`, `SQSQueue.lean` | Plan and apply, providers, and their proofs |
| `Alchemy/Cloud/Effect.lean`, `Layer.lean` | Services, Layers and typed errors |

## Limits

- Every proof about a stack is against a model of the cloud held in memory. Nothing here deploys to a real account.
- A host handles one request at a time, by design. The laws describe one call running alone.
- The request theorems assume JSON written to the journal reads back as written; that round trip is not proved.
- "Nothing bad happens" is routine. "Something good eventually happens" is proved once, in `examples/Bank/Pending.lean`.
- A decision cannot be sent through a hosted function; hosting takes commands only.
- A link joins two models, one way.
- The Cloudflare bindings have no laws and no access vocabulary yet.
