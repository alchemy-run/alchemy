# alchemy-lean

Alchemy in [Lean 4](https://lean-lang.org): a domain model, the stack that hosts it, and proofs about both. A prototype.

```sh
curl https://elan.lean-lang.org/elan-init.sh -sSf | sh
lake build        # proves every theorem and runs every story
```

Every snippet below is from `examples/` and compiles.

## An aggregate

A namespace with its types and two functions. `decide` answers a command with events or a rejection.

```lean
namespace Account

def decide (s : State) : Command → Except Rejection (List Event)
  | .withdraw _ amount =>
    if amount = 0 then .error .nothingToMove
    else match s.status with
      | .open =>
        if amount ≤ s.balance then .ok [.withdrawn amount]
        else .error (.insufficientFunds s.balance amount)
      | .frozen reason => .error (.frozen reason)
      | _ => .error .notOpen
  …
```

`evolve` applies one event to the state.

```lean
def evolve (s : State) : Event → State
  | .opened owner => { s with status := .open, owner }
  | .deposited amount =>
    { s with balance := s.balance + amount, deposited := s.deposited + amount }
  | .withdrawn amount =>
    { s with balance := s.balance - amount, withdrawn := s.withdrawn + amount }
  …
```

## A model

One block declares the aggregates and the systems outside the model.

```lean
model Bank where
  aggregate Account

  call screen (account : String) (amount : Nat) : Screening
  call wire (payout account : String) (amount : Nat) : WireResult
```

A policy reacts to an event. It may call outside and send commands.

```lean
  policy Compliance on Account
    | id, .deposited amount => do
      if amount ≥ 10000 then
        match ← screen id amount with
        | .flagged reason => Account.send (.freeze id reason)
        | .clear => pure ()
```

A decision reads several instances and records on all of them or none.

```lean
  decision Transfer (TransferRequest) : TransferRefused
    | accounts, ⟨source, destination, amount⟩ =>
      if (Account.of accounts source).balance < amount then
        .error (.insufficientFunds (Account.of accounts source).balance amount)
      else .ok [
        Account.record source (.transferredOut amount),
        Account.record destination (.transferredIn amount)]
```

A saga runs steps in order. `undoWith` says what to send if a later step fails.

```lean
  saga Payout (PayoutRequest) (Unit) : PayoutFailed
    | payout, ⟨account, amount⟩ => do
      Account.must (.withdraw account amount) fun _ => .refused
      Account.undoWith (.deposit account amount)
      match ← wire payout account amount with
      | .sent => pure ()
      | .bounced => failWith .bounced
```

A view folds a value over events. A projection writes rows for them.

```lean
  view Holdings on Account : Int := 0
    | total, .deposited amount => total + amount
    | total, .withdrawn amount => total - amount

  projection Statement on Account : String × String × Nat
    | id, .deposited amount => [(id, "deposit", amount)]
    | id, .withdrawn amount => [(id, "withdrawal", amount)]
```

## Behaviour

Given events, when a command, then a result. It holds for every id and amount.

```lean
theorem anOverdraftIsRefused (id owner : String) (held amount : Nat) (tooMuch : held < amount) :
    Account.decide (Account.after [.opened owner, .deposited held]) (.withdraw id amount)
      = .error (.insufficientFunds held amount)
```

## Invariants

A fact about the state. `aggregate_rule` proves no accepted command breaks it.

```lean
def Balanced (s : Account.State) : Prop := s.balance + s.withdrawn = s.deposited

theorem balanced_kept : Account.Keeps Balanced := by
  aggregate_rule [Account.decide, Account.evolve, Balanced]
```

Other facts follow from an invariant by arithmetic, for every history.

```lean
theorem neverPaysOutMoreThanCameIn (commands : List Account.Sent) :
    (Account.replay {} commands).withdrawn ≤ (Account.replay {} commands).deposited := by
  have := balanced.always commands
  simp only [balanced, Balanced] at this
  omega
```

`Account.always` lifts it to every world the model can reach: any callers, any outside answers, any delivery order.

```lean
theorem everyAccountBalanced (w : World Signature) (reach : Bank.Reachable w) (id : String) :
    Balanced (w.state .Account id) :=
  Account.always (by simp [Balanced]) balanced_kept w reach id transfer_balanced
```

`Account.deployed` does the same for the model as a function hosts it, whatever its journal holds.

```lean
theorem deployedAccountsBalanced (journal : List Journal.Line) (id : String) :
    Balanced ((served.replay journal).state .Account id) :=
  Account.deployed (by simp [Balanced]) balanced_kept journal id transfer_balanced
```

A rule across aggregates is stated over the whole record.

```lean
def Conserved (r : Recorded Aggregates) : Prop :=
  ((r.eventsOf .Account).map movedOut).sum = ((r.eventsOf .Account).map movedIn).sum

theorem noTransferCreatesMoney (w : World Signature) (reach : Bank.Reachable w) :
    Conserved w.toRecorded
```

Views and projections come with their theorems.

```lean
#check (Holdings.exact : ∀ log, Holdings.stateAt log () = log.foldl Holdings.step 0)
#check (Statement.exact : ∀ log, Statement.table log = log.flatMap Statement.rows)
```

## Scenarios

A scenario is a list of moves: commands sent, and outside calls answered.

```lean
def aPayoutBounces (id owner payout : String) (held amount : Nat) : List (Model.Move Bank) := [
  .send ⟨.Account, (), .open id owner⟩,
  .send ⟨.Account, (), .deposit id held⟩,
  .send ⟨.Account, (), .requestPayout id payout amount⟩,
  .answer (.wire payout id amount) .bounced]
```

A theorem proves its outcome for every input. `behaviour` runs the model with the variables left as they are.

```lean
theorem aBouncedPayoutIsRefunded (id owner payout : String) (held amount : Nat)
    (some : amount ≠ 0) (enough : amount ≤ held) (modest : held < 10000) :
    let bank := Bank.run (aPayoutBounces id owner payout held amount)
    (bank.state .Account id).balance = held ∧ bank.sagas payout = .failed .bounced := by
  …
  behaviour [aPayoutBounces]
```

A story follows the same scenario with real values and checks each step. `.next` makes the next move.

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

## Two models

A `Link` says which of one model's calls another model answers.

```lean
def screening : Link Bank Compliance where
  ask
    | .screen account amount => some ⟨.Watch, (), .assess account amount⟩
    | .wire .. => none
  reply
    | .screen .., ⟨.Watch, _, _⟩, .ok [.flagged _] => .flagged "over the reporting threshold"
    | .screen .., _, _ => .clear
    | .wire .., _, _ => .bounced
```

What was proved of each model holds of both, with nothing proved again.

```lean
theorem bothAreSound (w : screening.Worlds) (reach : screening.Reachable w) (account : String) :
    Bank.Balanced (w.1.state .Account account) ∧
      Bank.Conserved w.1.toRecorded ∧
      Compliance.FlagsAreAssessments (w.2.state .Watch account) :=
  ⟨Bank.everyAccountBalanced _ (screening.reachable_left reach) account,
    Bank.noTransferCreatesMoney _ (screening.reachable_left reach),
    Compliance.everyWatchIsSound _ (screening.reachable_right reach) account⟩
```

`behaviour` proves a flow across the two.

```lean
theorem aReportableDepositFreezesTheAccount (id owner : String) (amount : Nat)
    (reportable : amount ≥ 50000) :
    let both := screening.run [
      .send ⟨.Account, (), .open id owner⟩,
      .send ⟨.Account, (), .deposit id amount⟩]
    (both.1.state .Account id).status = .frozen "over the reporting threshold" ∧
      both.2.state .Watch id = { assessed := 1, flagged := 1 }
```

## A stack

Resources and functions are steps of the stack's block.

```lean
def ShopStack : Stack Kind Outputs where
  name := "Shop"
  body := do
    let orders ← S3.Bucket "Orders"
    let shipments ← SQS.Queue "Shipments"
    let api ← Api orders shipments
    let warehouse ← Warehouse orders shipments
    return { orders, shipments, api, warehouse }
```

A binding is a step of a function's block. Its grant goes into the function's role; nobody writes the role.

```lean
def Api (orders : Bucket) (shipments : Queue) : Construct Kind Function :=
  Lambda.Function "Api" { url := true } do
    let journal ← S3.Journal orders
    let queue ← SQS.SendMessage shipments
    return route (served.host journal (outside queue))
```

`served.host` runs a domain model on a journal. Each outside call of the model is answered through a binding.

```lean
def outside (queue : SQS.SendMessage.Client shipments role) : (c : Call) → Run role Never (Reply c)
  | .charge order amount => pure (sandboxCharge order amount)
  | .ship order item => queue.call s!"{order}:{item}"
```

Consuming a queue is a step. It registers the function as the queue's consumer.

```lean
def Warehouse (orders : Bucket) (shipments : Queue) : Construct Kind Function :=
  Lambda.Function "Warehouse" {} do
    let slips ← S3.PutObject orders ["packed"]

    SQS.consume shipments fun shipment => do
      match shipment.splitOn ":" with
      | [order, item] => slips.call order item
      | _ => pure ()

    return fun _ => return { status := 204 }
```

A Cloudflare Worker is the same, and ends with `fetch` and typed methods other Workers call.

```lean
def Inbox (mail : Bucket) (incoming : Queue) : Construct Kind (Worker Api) :=
  Workers.Worker "Inbox" {} Api do
    let mail ← R2.ReadWrite mail
    let queue ← Queues.Send incoming

    Queues.consume incoming fun message => do
      let stored ← mail.list
      mail.put (toString stored.length) message

    return {
      fetch := fun request => do
        match request.method, request.path with
        | "POST", "/messages" =>
          queue.send request.body
          return { status := 202 }
        | _, _ => return { status := 404 }
      rpc := fun
        | .count => return (← mail.list).length
        | .read id => mail.get (toString id) }
```

## Access

Who can do what, for every key under a prefix. `stack_rule` computes each role from the stack.

```lean
theorem onlyTheApiWritesHistory :
    prod.only [out.api] (S3.writing out.orders ["journal"]) := by
  stack_rule in prod using [out, BucketOp.covers]

theorem theWarehouseReadsNothing :
    prod.never out.warehouse (S3.reading out.orders) := by
  stack_rule in prod using [out, BucketOp.covers]

theorem nobodyListsTheOrders : prod.nobody (S3.listing out.orders) := by
  stack_rule in prod using [out, BucketOp.covers]

theorem shipmentsGoOneWay :
    prod.only [out.api] (SQS.sending out.shipments) ∧
      prod.only [out.warehouse] (SQS.receiving out.shipments) := by
  constructor <;> stack_rule in prod using [out]
```

## Stories for a stack

Requests and what they must answer, run against the whole stack in memory.

```lean
def anOrder : List (Graph.Step Kind InMemory) := [
  post out.api "/orders" (Order.Command.place "o-1" "kettle" 40) ⇒ (200, "paid ch_o-1"),
  .holds "the warehouse filed a slip" (·.object out.orders ["packed", "o-1"] == some "kettle"),
  .holds "and took the shipment off the queue" (·.queued out.shipments == []),
  get out.api "/orders/o-1" ⇒ (200, "paid ch_o-1"),
  post out.api "/orders" (Order.Command.place "o-1" "kettle" 40)
    ⇒ (409, "Order.Rejection.alreadyPlaced"),
  get out.api "/revenue" ⇒ (200, "40") ]

example : prod.passes anOrder = true := by native_decide
```

No function holds a grant it never uses. The story is the run that uses each one.

```lean
theorem leastPrivilege : prod.LeastPrivilege InMemory :=
  .of_stories [anOrder] (by native_decide)
```

## Behaviour of a function

Given what the bucket holds, when a request arrives, then the response and the bucket afterwards.

```lean
theorem gettingAnOrder (id : String) (cloud : Memory) :
    (getOrder (theShop le queue) id).eval InMemory cloud
      = (.ok (describe ((shopIn orders cloud).state .Order id)), cloud)
```

A response follows from the domain's `decide`, for every item and amount.

```lean
theorem placingAnOrderTwiceIsRefused (id item : String) (amount : Nat) (cloud : Memory)
    (whole : Whole orders cloud)
    (placed : ((shopIn orders cloud).state .Order id).status ≠ .new) :
    ((postOrder (theShop le queue) (.place id item amount)).eval InMemory cloud).1
      = .ok { status := 409, body := reprStr Order.Rejection.alreadyPlaced }
```

These rest on a law per binding: what a call answers and what it does to the cloud.

```lean
structure PutObject.Lawful (client : PutObject.Client bucket under access) : Prop where
  put : ∀ (m : Memory) (name body : String),
    (client.call name body).eval InMemory m = (.ok (), m.put bucket (under ++ [name]) body)
```

## Deploying

The plan for a fresh account, and a second deploy that changes nothing.

```lean
example : plan Control.providers prod fresh.state = [
    ("Orders", .create), ("Shipments", .create), ("Api", .create), ("Warehouse", .create)] := by
  native_decide

example : (deploy prod fresh).2 = true ∧
    plan Control.providers prod (deploy prod fresh).1.state = [
      ("Orders", .noop), ("Shipments", .noop), ("Api", .noop), ("Warehouse", .noop)] := by
  native_decide
```

## Examples

| File | Shows |
|---|---|
| `examples/Wallet.lean` | One aggregate, one invariant, one story |
| `examples/Accounts.lean` | The bank above |
| `examples/Linked.lean` | The bank linked to a compliance model |
| `examples/Shop.lean` | A model on an AWS stack |
| `examples/Inbox.lean` | Cloudflare Workers |
| `examples/Jobs.lean` | Services, Layers and typed errors |
| `examples/Bank/` | A larger bank in the long form: keyed views, streams, queries, actors |

## Limits

- Stacks run against a cloud held in memory. Nothing deploys to a real account.
- A host handles one request at a time, by design.
- `model` takes one saga, string ids, and views of one value over one aggregate.
- A decision cannot be sent through a hosted function.
- The Cloudflare bindings have no laws and no access vocabulary.
