# alchemy-lean

Alchemy in [Lean 4](https://lean-lang.org): a domain model, the stack that hosts it, and proofs about both. A prototype.

```sh
curl https://elan.lean-lang.org/elan-init.sh -sSf | sh
lake build        # proves every theorem and runs every story
```

New to Lean? Start with [GUIDE.md](./GUIDE.md), which builds one program step by step and explains how to read each piece. This page shows every feature, one snippet each.

Every snippet below is from `examples/` and compiles.

## An aggregate

A block with its commands, events, rejections and state, and three functions. Each command says what it may record and how it may be refused, and that is checked against `decide`. `decide` answers a command with events or a rejection, and `evolve` applies one event.

```lean
aggregate Order where
  command
    | place (id item : String) (amount : Nat)
        records placed
        rejects alreadyPlaced, nothingToCharge
    | settle (id charge : String)
        records paid
        rejects notAwaitingPayment
    | decline (id reason : String)
        records declined
        rejects notAwaitingPayment

  event
    | placed (item : String) (amount : Nat)
    | paid (charge item : String) (amount : Nat)
    | declined (reason : String)

  rejection
    | alreadyPlaced
    | nothingToCharge
    | notAwaitingPayment

  state
    status : Status := .new
    item : String := ""
    amount : Nat := 0
    charged : Nat := 0

  decide
    | s, .place _ item amount =>
      if s.status ≠ .new then .error .alreadyPlaced
      else if amount = 0 then .error .nothingToCharge
      else .ok [.placed item amount]
    | s, .settle _ charge =>
      if s.status = .awaitingPayment then .ok [.paid charge s.item s.amount]
      else .error .notAwaitingPayment
    | s, .decline _ reason =>
      if s.status = .awaitingPayment then .ok [.declined reason]
      else .error .notAwaitingPayment

  evolve
    | s, .placed item amount => { s with status := .awaitingPayment, item, amount }
    | s, .paid charge _ amount => { s with status := .paid charge, charged := s.charged + amount }
    | s, .declined reason => { s with status := .declined reason }
```

`reply` is what an accepted command answers its caller. It is given the state after the command's events are applied, and its type is the command's response type.

```lean
  reply : Status
    | s, _ => s.status
```

The block writes plain definitions, `Order.decide`, `Order.evolve`, `Order.reply`, which is what theorems name.

## A model

One block declares the aggregates and the systems outside the model. A model has as many aggregates as it needs, and a policy on one can send to another (`examples/Shop.lean` has `Order` and `Shipment`).

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
      …
      else if (Account.of accounts source).balance < amount then
        .error (.insufficientFunds (Account.of accounts source).balance amount)
      else .ok [
        Account.record source (.transferredOut amount),
        Account.record destination (.transferredIn amount)]
```

A saga runs steps in order. `undoWith` says what to send if a later step fails. A model can have several, each with its own failures.

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

A view can keep a value for each instance.

```lean
  view Balances on Account by id : Int := 0
    | balance, .deposited amount => balance + amount
    | balance, .withdrawn amount => balance - amount
    | balance, .transferredIn amount => balance + amount
    | balance, .transferredOut amount => balance - amount
```

A stream is an ordered log per instance, and a query answers from everything recorded.

```lean
  stream Activity on Account : String
    | _, .deposited amount => [s!"+{amount}"]
    | _, .withdrawn amount => [s!"-{amount}"]
    | _, .frozen reason => [s!"frozen: {reason}"]

  query Frozen (Unit) : String
    | log, _ => (log.filterMap fun
        | ⟨.Account, id, .frozen _, _, _⟩ => some id
        | _ => none).eraseDups
```

An aggregate can say who sends its commands. `decide` is then given the actor first.

```lean
aggregate Watch where
  actor : Who

  decide
    | _, _, .assess _ amount =>
      if amount = 0 then .error .nothingToAssess
      else if amount ≥ 50000 then .ok [.flagged amount]
      else .ok [.cleared amount]
    | .officer name, s, .dismiss _ =>
      if s.flagged = 0 then .error .nothingFlagged else .ok [.dismissed name]
    | .system, _, .dismiss _ => .error .notAnOfficer
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
  aggregate_rule
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
theorem everyAccountBalanced (w : Alchemy.World Signature) (reach : Bank.Reachable w)
    (id : String) : Balanced (w.state .Account id) :=
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

theorem noTransferCreatesMoney (w : Alchemy.World Signature) (reach : Bank.Reachable w) :
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
    (bank.state .Account id).balance = held ∧ bank.sagas (.Payout, payout) = .failed (.Payout .bounced) := by
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
    .saga (.Payout, "p-1") (.failed (.Payout .bounced)),
    .recorded .Account "a-1" [.opened "Sam", .deposited 500, .payoutRequested "p-1" 200,
      .withdrawn 200, .deposited 200]
  ] = true := by decide
```

## Two models

A `Link` says which of one model's calls another model answers.

```lean
def screening : Link Bank Compliance where
  ask
    | .screen account amount => some ⟨.Watch, .system, .assess account amount⟩
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

Any number of models join in a `Network`. The same holds of all of them, and a run goes through each.

```lean
theorem allThreeAreSound (w : institution.Worlds) (reach : institution.Reachable w)
    (account : String) (payout : WireId) :
    Bank.Balanced ((w .bank).state .Account account) ∧
      Bank.Conserved (w .bank).toRecorded ∧
      Compliance.FlagsAreAssessments ((w .compliance).state .Watch account) ∧
      Wires.SentOnce ((w .wires).state .Transfer payout) :=
```

## Eventually

Left to run, a flow comes to rest with nothing in flight and the outcome it should have.

```lean
theorem anApprovedOrderEventuallyShips (id item charge : String) (amount : Nat)
    (priced : amount ≠ 0) :
    Shop.Eventually
      (Shop.run [
        .send ⟨.Order, (), .place id item amount⟩,
        .answer (.charge id amount) (.approved charge),
        .answer (.ship id item) ()])
      fun shop => shop.Settled ∧ (shop.state .Order id).status = .paid charge ∧
        (shop.state .Shipment id).item = some item := by
  refine Shop.eventually_now _ ?_ ?_ <;> behaviour
```

`comes_to_rest` proves that a model stops from any world it can reach. It finds a weight for each event, command and saga so that every step lowers the total; nobody writes the weights.

```lean
comes_to_rest Shop

theorem theShopComesToRest (w : Alchemy.World Signature) (reach : Shop.Reachable w) :
    ∃ steps, Shop.AtRest (Shop.settle steps w) :=
  Shop.comesToRest w reach
```

The same line covers sagas and their undos. The weights it found can be read.

```lean
comes_to_rest Bank

example : ranking.event .Account (.payoutRequested "p-1" 200) = 21 := rfl
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

A function calls the operations it needs. Its role is read off those calls; nobody writes it.

```lean
def Warehouse (orders : Bucket) (shipments : Queue) : Construct Kind Function :=
  Lambda.Function "Warehouse" {} do
    SQS.consume shipments fun shipment => do
      match shipment.splitOn ":" with
      | [order, item] => S3.putObject orders ["packed"] order item
      | _ => pure ()

    return fun _ => return { status := 204 }
```

`served.host` runs a domain model on a journal, and says who answers each call the model makes to the outside.

```lean
helper theShop {role : Access Kind} (orders : Bucket) (shipments : Queue) : Hosted served role :=
  served.host (S3.journal orders) fun
    | .charge order amount => pure (sandboxCharge order amount)
    | .ship order item => SQS.sendMessage shipments s!"{order}:{item}"

def Api (orders : Bucket) (shipments : Queue) : Construct Kind Function := do
  let stage ← stage
  Lambda.Function "Api" { url := true, memory := if stage = "prod" then 1024 else 512 } do
    return route (theShop orders shipments)
```

A Cloudflare Worker is the same, and ends with `fetch` and typed methods other Workers call.

```lean
def Inbox (mail : Bucket) (incoming : Queue) : Construct Kind (Worker Api) :=
  Workers.Worker "Inbox" {} Api do
    Queues.consume incoming fun message => store mail message

    return {
      fetch := fun request => do
        match request.method, request.path with
        | "POST", "/messages" =>
          Queues.send incoming request.body
          return { status := 202 }
        | _, _ => return { status := 404 }
      rpc := fun
        | .count => return (← R2.list mail).length
        | .read id => R2.get mail (toString id) }
```

## Access

Who can do what, for every key under a prefix. `stack_rule` computes each role from the stack.

```lean
theorem onlyTheApiWritesHistory :
    prod.only [out.api] (S3.writing out.orders ["journal"]) := by
  stack_rule in prod

theorem theWarehouseReadsNothing :
    prod.never out.warehouse (S3.reading out.orders) := by
  stack_rule in prod

theorem nobodyListsTheOrders : prod.nobody (S3.listing out.orders) := by
  stack_rule in prod

theorem shipmentsGoOneWay :
    prod.only [out.api] (SQS.sending out.shipments) ∧
      prod.only [out.warehouse] (SQS.receiving out.shipments) := by
  constructor <;> stack_rule in prod
```

## A story, told to the stack

The same story as the domain's, word for word. Each command goes in through the Api, the bindings answer the model's calls, and what is recorded is read back from the bucket.

```lean
def deployed : Telling Shop InMemory where
  kind := .function
  host := out.api
  request
    | ⟨.Order, _, command⟩ => (post out.api "/orders" command).request
  world := shopIn out.orders

example : prod.tells deployed aKettle = true := by native_decide
```

## Testing a stack

Requests and what they must answer, run against the whole stack in memory. These are tests of the wiring, in HTTP and buckets; stories stay in the domain's language.

```lean
def postingAnOrder : List (Graph.Step Kind InMemory) := [
  post out.api "/orders" (Order.Command.place "o-1" "kettle" 40) ⇒ (200, "paid ch_o-1"),
  .holds "the warehouse filed a slip" (·.object out.orders ["packed", "o-1"] == some "kettle"),
  .holds "and took the shipment off the queue" (·.queued out.shipments == []),
  get out.api "/orders/o-1" ⇒ (200, "paid ch_o-1"),
  post out.api "/orders" (Order.Command.place "o-1" "kettle" 40)
    ⇒ (409, "Order.Rejection.alreadyPlaced"),
  get out.api "/revenue" ⇒ (200, "40") ]

example : prod.passes postingAnOrder = true := by native_decide
```

## Least privilege

A role holds only what a call in the function's code asks for, so there is nothing to state: delete the call and the permission goes with it.

`lake exe shop graph prod --why` prints the call behind each grant.

```
  Api
    may        read Orders/journal
                 ← Shop.lean:280  theShop _ orders shipments
    may        send to Shipments
                 ← Shop.lean:280  theShop _ orders shipments
  Warehouse
    may        write Orders/packed
                 ← Shop.lean:279  S3.putObject orders ["packed"] order item
    may        receive from Shipments
                 ← Shop.lean:277  SQS.consume shipments fun shipment => do match shipment.s…
```

A test gives the stronger claim: each grant is not only written but used in a run.

```lean
theorem leastPrivilege : prod.LeastPrivilege InMemory :=
  .of_tests [postingAnOrder] (by native_decide)
```

## Behaviour of a function

Given what the bucket holds, when a request arrives, then the response and the bucket afterwards.

```lean
theorem gettingAnOrder (id : String) (cloud : Memory) :
    (getOrder (theShop (role := role) orders shipments) id).eval InMemory cloud
      = (.ok (describe ((shopIn orders cloud).state .Order id).status), cloud)
```

A response follows from the domain's `decide`, for every item and amount.

```lean
theorem placingAnOrderTwiceIsRefused (id item : String) (amount : Nat) (cloud : Memory)
    (whole : Whole orders cloud)
    (placed : ((shopIn orders cloud).state .Order id).status ≠ .new) :
    ((postOrder (theShop (role := role) orders shipments) (.place id item amount)).eval InMemory cloud).1
      = .ok { status := 409, body := reprStr Order.Rejection.alreadyPlaced }
```

These rest on a law per binding: what a call answers and what it does to the cloud.

```lean
structure PutObject.Lawful {bucket : AWS.Bucket} {under : Path}
    (client : PutObject.Client bucket under access) : Prop where
  put : ∀ (m : Memory) (name body : String),
    (client.call name body).eval InMemory m = (.ok (), m.put bucket (under ++ [name]) body)
```

## Run it

A stack is a value, so its graph is computed from the code. `lake exe shop graph prod` prints it.

```
Shop (prod)

  Orders
  Shipments
  Api
    needs      Orders, Shipments
    may        read Orders/journal
    may        write Orders/journal
    may        read Orders/journal/lines
    may        write Orders/journal/lines
    may        send to Shipments
  Warehouse
    needs      Orders, Shipments
    may        write Orders/packed
    may        receive from Shipments
    consumes   Shipments
```

`lake exe shop plan prod` prints the plan for a fresh account.

```
  + create   Orders
  + create   Shipments
  + create   Api
  + create   Warehouse

  4 to create, 0 to update, 0 to replace, 0 to delete, 0 unchanged
```

`lake exe shop plan prod after dev` plans against an account the dev stage was deployed to.

```
    no-op    Orders
    no-op    Shipments
  ~ update   Api
                 memory: 512 → 1024
    no-op    Warehouse

  0 to create, 1 to update, 0 to replace, 0 to delete, 3 unchanged
```

The program is one line.

```lean
def main (args : List String) : IO UInt32 := Alchemy.AWS.cli Shop.ShopStack args
```

The same plan is a value a theorem can state.

```lean
example : plan Control.providers prod fresh.state = [
    ("Orders", .create), ("Shipments", .create), ("Api", .create), ("Warehouse", .create)] := by
  native_decide
```

In the editor, `#eval` shows any of it without running a program.

```lean
-- #eval prod.order   gives ["Orders", "Shipments", "Api", "Warehouse"]
-- #eval prod.edges   gives [("Api", "Orders"), ("Api", "Shipments"), …]
```

`python3 check-docs.py` checks that every line of Lean on this page and in the guide is in the library or an example.

## Examples

| File | Shows |
|---|---|
| `examples/Wallet.lean` | One aggregate, one invariant, one story |
| `examples/Accounts.lean` | The bank above |
| `examples/Linked.lean` | The bank linked to a compliance model |
| `examples/Shop.lean` | A model on an AWS stack |
| `examples/Uploads.lean` | Proving an infrastructure design: uploads that cannot be served before they are scanned |
| `examples/Inbox.lean` | Cloudflare Workers |
| `examples/Jobs.lean` | Services, Layers and typed errors |
| `examples/Bank/` | A larger bank in the long form: keyed views, streams, queries, actors |

## Limits

- Stacks run against a cloud held in memory. Nothing deploys to a real account.
- A host handles one request at a time, by design.
