# A guide to alchemy-lean

This walks through one program, `examples/Shop.lean`, from nothing. Each step has the code, how to read it, and what it gives you. Every snippet compiles.

## 1. Describe a thing: the aggregate

An aggregate is something whose rules must hold together, here an order. You list what it can be asked, what it records, how it refuses, and what it remembers.

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
```

**Reading it.** Each `|` line is one case. `(id item : String)` is two fields, both strings. `Nat` is a whole number that cannot be negative. In `state`, `:= .new` is the starting value.

## 2. Give it behaviour: decide and evolve

Two functions hold all the logic. `decide` answers a command; `evolve` applies one event.

```lean
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

  reply : Status
    | s, _ => s.status
```

**Reading it.** Each `| pattern => result` is a branch, like a `switch`. `s` is the current state, and `_` is a field that is not used. `.ok [...]` accepts and lists events; `.error ...` refuses. `{ s with status := … }` is a copy of `s` with some fields changed. `reply` is what an accepted command answers, from the state it left.

**What you get.** `decide` only answers and `evolve` is the only place state changes. The `records` and `rejects` lines of step 1 are checked against `decide`: omit a rejection it can give, or name an event it cannot record, and the file does not compile.

## 3. Say what is always true: an invariant

A rule about the state, and one line proving no command breaks it.

```lean
def ChargedOnce (s : Order.State) : Prop :=
  (s.status = .new ∨ s.status = .awaitingPayment → s.charged = 0) ∧ s.charged ≤ s.amount

theorem chargedOnce : Order.Keeps ChargedOnce := by
  aggregate_rule [Order.decide, Order.evolve, ChargedOnce]
```

**Reading it.** `Prop` is a statement that is true or false. `∨` is or, `∧` is and, `→` is implies. `theorem name : claim := by tactic` is a claim and how to prove it. `aggregate_rule` tries every command and every branch of `decide`.

**What you get.** Unlike a test, this covers every order and every sequence of commands. Delete the status check from `settle` and this line fails.

## 4. Say what happens in a case: behaviour

Given some history, when a command arrives, then this result.

```lean
theorem aPaidOrderIsNeverChargedAgain (id item charge again : String) (amount : Nat) :
    Order.decide (Order.after [.placed item amount, .paid charge item amount]) (.settle id again)
      = .error .notAwaitingPayment := by
  simp [Aggregate.after, Aggregate.apply, Order.decide, Order.evolve]
```

**Reading it.** The names in brackets before the `:` are "for every". `Order.after [events]` is the state after those events. A call has no brackets or commas: `f a b` is `f(a, b)`. `simp` proves it by unfolding the named definitions and computing.

General properties are stated the same way. Every order command is idempotent, so a caller unsure it arrived can send it again:

```lean
theorem everyOrderCommandIsIdempotent : Order.Idempotent := by
  command_law [Order.decide, Order.evolve]
```

## 5. Connect things: the model

A model joins aggregates to each other and to the outside world.

```lean
model Shop where
  aggregate Order
  aggregate Shipment

  call charge (order : String) (amount : Nat) : Charge
  call ship (order item : String) : Unit

  policy Payment on Order
    | id, .placed _ amount => do
      match ← charge id amount with
      | .approved chargeId => Order.send (.settle id chargeId)
      | .refused reason => Order.send (.decline id reason)

  policy Fulfilment on Order
    | id, .paid _ item _ => Shipment.send (.schedule id item)

  policy Dispatch on Shipment
    | id, .scheduled item => ship id item

  view Revenue on Order : Nat := 0
    | total, .paid _ _ amount => total + amount

  projection Packing on Shipment : String × String
    | id, .scheduled item => [(id, item)]
```

**Reading it.** A `call` names something outside the model and what it answers, not how. A `policy` is "whenever this event is recorded, do that". `do` starts a sequence of steps, and `←` runs a step and takes its result, like `await`. A `view` is a value kept up to date from events; a `projection` writes rows.

**What you get.** The invariant of step 3 holds across the whole model, and of the model as a function hosts it, in one line each: any callers, any gateway answer, any delivery order, any event delivered twice.

```lean
theorem everyOrderChargedOnce (w : World Signature) (reach : Shop.Reachable w) (id : String) :
    ChargedOnce (w.state .Order id) :=
  Order.always (by simp [ChargedOnce]) chargedOnce w reach id

theorem deployedOrdersChargedOnce (journal : List Journal.Line) (id : String) :
    ChargedOnce ((served.replay journal).state .Order id) :=
  Order.deployed (by simp [ChargedOnce]) chargedOnce journal id
```

## 6. Prove a whole flow

A script of what happens, and a claim about where things end up.

```lean
theorem anApprovedOrderIsPaidAndShipped (id item charge : String) (amount : Nat)
    (priced : amount ≠ 0) :
    let shop := Shop.run [
      .send ⟨.Order, (), .place id item amount⟩,
      .answer (.charge id amount) (.approved charge)]
    (shop.state .Order id).status = .paid charge ∧
      (shop.state .Shipment id).item = some item ∧
      Shop.waiting shop = [.ship id item] := by
  behaviour
```

**Reading it.** `.send` is a caller sending a command. `.answer` is the theorem saying "suppose the gateway replies this". `let shop := …` names the world after the script. `(priced : amount ≠ 0)` is an assumption the proof may use. `behaviour` runs the script with `id` and `amount` left as unknowns.

## 7. Show one concrete case: a story

The same thing with real values, so a person can read it and check it is what they meant.

```lean
example : Shop.passes [
    .when ⟨.Order, (), .place "o-1" "kettle" 40⟩,
    .call (.charge "o-1" 40),
    .answer (.charge "o-1" 40) (.approved "ch_1"),
    .recorded .Order "o-1" [.placed "kettle" 40, .paid "ch_1" "kettle" 40],
    .recorded .Shipment "o-1" [.scheduled "kettle"],
    .call (.ship "o-1" "kettle"),
    .answer (.ship "o-1" "kettle") (),
    .view Revenue () 40,
    .when ⟨.Order, (), .settle "o-1" "ch_2"⟩,
    .rejected .Order .notAwaitingPayment
  ] = true := by decide
```

**Reading it.** `example` is a theorem with no name. `by decide` proves it by running it, which works because nothing is unknown. A theorem says it always holds; a story shows what "it" is.

## 8. Put it on infrastructure

A stack declares resources. A function calls what it needs, and its permissions are worked out from those calls.

```lean
helper theShop {role : Access Kind} (orders : Bucket) (shipments : Queue) : Hosted served role :=
  served.host (S3.journal orders) fun
    | .charge order amount => pure (sandboxCharge order amount)
    | .ship order item => SQS.sendMessage shipments s!"{order}:{item}"

def Api (orders : Bucket) (shipments : Queue) : Construct Kind Function := do
  let stage ← stage
  Lambda.Function "Api" { url := true, memory := if stage = "prod" then 1024 else 512 } do
    return route (theShop orders shipments)

def Warehouse (orders : Bucket) (shipments : Queue) : Construct Kind Function :=
  Lambda.Function "Warehouse" {} do
    SQS.consume shipments fun shipment => do
      match shipment.splitOn ":" with
      | [order, item] => S3.putObject orders ["packed"] order item
      | _ => pure ()

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

**Reading it.** `def name (inputs) : Type := body` defines a function, and `fun x => …` is an anonymous one. `helper` defines a function whose permissions are read off its body, so nobody lists them. `theShop` hosts the model: its history is a journal in the bucket, and it says who answers `charge` and `ship`. `SQS.consume` registers the function as the queue's consumer.

## 9. Prove who can touch what

Take the bucket in this stack. It holds two things with very different stakes.

Under `journal/` is the shop's history: every order and every payment. It is the system of record. Everything proved in steps 3 to 6 assumes one thing about it: only the function that hosts the model appends to it. If anything else can write there, an order can be recorded as paid that nobody charged, and every domain proof is about a history that is no longer the real one.

Under `packed/` are packing slips, written by a warehouse function that has no business seeing what customers ordered or paid.

So there are two rules this infrastructure must keep, and today they are usually kept by someone reading IAM policy diffs in review:

1. **One writer for the system of record.** Only the Api writes under `journal/`.
2. **The warehouse cannot read customer data.** It writes slips and reads nothing.

Here they are theorems about the stack.

```lean
/-- Only the Api writes the shop's history. -/
theorem onlyTheApiWritesHistory :
    prod.only [out.api] (S3.writing out.orders ["journal"]) := by
  stack_rule in prod

/-- The Warehouse reads nothing in the bucket: no order, and none of the history. -/
theorem theWarehouseReadsNothing :
    prod.never out.warehouse (S3.reading out.orders) := by
  stack_rule in prod
```

**Reading it.** `prod` is the stack at the "prod" stage and `out` is what it built. `S3.writing out.orders ["journal"]` means writing any object under `journal/`, so each rule covers every key, not a sample. `stack_rule` computes each function's role from the stack and checks the rule against it.

**What you get.** The rules hold as the code changes. Suppose someone, months later, makes the Warehouse read the order count from the journal to number its slips:

```diff
  SQS.consume shipments fun shipment => do
    match shipment.splitOn ":" with
-   | [order, item] => S3.putObject orders ["packed"] order item
+   | [order, item] => do
+     let _ ← S3.getObject orders ["journal"] "count"
+     S3.putObject orders ["packed"] order item
```

The call asks for a grant, the Warehouse's role gains "read Orders/journal", and the build stops at the rule that said it must not:

```
Shop.lean: error: unsolved goals          ← theWarehouseReadsNothing
```

Nobody reviewed a policy. The change looked harmless and would have deployed; the build refused it because the rule about customer data was written down once. The first rule is what connects the two halves of this guide: it is the stack-side fact that the domain proofs rely on.

The opposite mistake, a permission left behind after the code that needed it is deleted, needs no rule at all. A role holds only what a call in the code asks for, so deleting the call removes the permission.

`--why` shows the line behind each permission, which is what you would otherwise reconstruct by hand in a review:

```
$ lake exe shop graph prod --why

  Warehouse
    may        write Orders/packed
                 ← Shop.lean:334  S3.putObject orders ["packed"] order item
    may        receive from Shipments
                 ← Shop.lean:332  SQS.consume shipments fun shipment => do match shipment.s…
```

The domain's story also runs against the stack. It is step 7 again, but each command goes in through the Api, and the gateway and the queue answer the model's calls. This is what shows the wiring does what the model says.

```lean
example : prod.tells deployed [
    .when ⟨.Order, (), .place "o-1" "kettle" 40⟩,
    .recorded .Order "o-1" [.placed "kettle" 40, .paid "ch_o-1" "kettle" 40],
    .recorded .Shipment "o-1" [.scheduled "kettle"],
    .view Revenue () 40,
    .when ⟨.Order, (), .place "o-1" "kettle" 40⟩,
    .rejected .Order .alreadyPlaced
  ] = true := by native_decide
```

## 10. Run it

```sh
curl https://elan.lean-lang.org/elan-init.sh -sSf | sh && source ~/.elan/env
cd packages/alchemy-lean
lake build                        # checks every theorem and story
lake exe shop graph prod --why    # resources, permissions, and the line behind each
lake exe shop plan prod after dev # what a deploy would change
```

```
  Warehouse
    needs      Orders, Shipments
    may        write Orders/packed
                 ← Shop.lean:334  S3.putObject orders ["packed"] order item
    may        receive from Shipments
                 ← Shop.lean:332  SQS.consume shipments fun shipment => do match shipment.s…
    consumes   Shipments

    no-op    Orders
    no-op    Shipments
  ~ update   Api
    no-op    Warehouse
```

## The pattern

Each layer has the same three moves.

| | Define | Prove always | Show once |
|---|---|---|---|
| Aggregate | `aggregate` | invariant, behaviour | story |
| Model | `model` | flow theorem | story |
| Stack | `Stack`, functions | who can touch what | story told to the stack |

Write the definition, write a story to see it do the right thing, then turn what must always hold into a theorem. A first exercise: change `amount = 0` to `amount < 5` in `decide`, run `lake build`, and see which theorems and stories depended on that line.
