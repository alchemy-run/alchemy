import Alchemy

/-!
# A shop

One program, end to end: a domain, the policies that connect it to the systems
outside it, those systems as services, the layers that put each service on a
resource, and the stack that deploys it all. Then what is proved about each
part, and stories the compiler runs.
-/

open Alchemy Cloud AWS

namespace Shop

/-! ## The domain: an order -/

inductive Command where
  | place (id item : String) (amount : Nat)
  | settle (id charge : String)
  | decline (id reason : String)
deriving DecidableEq, Repr, Lean.ToJson, Lean.FromJson

inductive Event where
  | placed (item : String) (amount : Nat)
  | paid (charge item : String) (amount : Nat)
  | declined (reason : String)
deriving DecidableEq, Repr

inductive Rejection where
  | alreadyPlaced
  | nothingToCharge
  | notAwaitingPayment
deriving DecidableEq, Repr

inductive Status where
  | new
  | awaitingPayment
  | paid (charge : String)
  | declined (reason : String)
deriving DecidableEq, Repr

structure State where
  status : Status := .new
  item : String := ""
  amount : Nat := 0
  charged : Nat := 0
deriving DecidableEq, Repr

/-- Decide: the events a command records, or why it is refused. -/
def decide (_ : Context Unit) (s : State) : Command → Except Rejection (List Event)
  | .place _ item amount =>
    if s.status ≠ .new then .error .alreadyPlaced
    else if amount = 0 then .error .nothingToCharge
    else .ok [.placed item amount]
  | .settle _ charge =>
    if s.status = .awaitingPayment then .ok [.paid charge s.item s.amount]
    else .error .notAwaitingPayment
  | .decline _ reason =>
    if s.status = .awaitingPayment then .ok [.declined reason]
    else .error .notAwaitingPayment

/-- Evolve: what an event does to the state. -/
def evolve (s : State) (e : Event) (_ : Time) : State :=
  match e with
  | .placed item amount => { s with status := .awaitingPayment, item, amount }
  | .paid charge _ amount => { s with status := .paid charge, charged := s.charged + amount }
  | .declined reason => { s with status := .declined reason }

end Shop

open Shop in
abbrev Order : Aggregate where
  name := "Order"
  Id := String
  State := State
  Command := Command
  Event := Event
  Rejection := Rejection
  Actor := Unit
  initial := {}
  keyOf := fun | .place id .. | .settle id _ | .decline id _ => id
  decide := decide
  evolve := evolve

namespace Shop

/-! ## The systems outside it, and the policies that reach them -/

/-- What the payment gateway answers. -/
inductive Charge where
  | approved (id : String)
  | refused (reason : String)
deriving DecidableEq, Repr, Lean.ToJson, Lean.FromJson

/-- The calls the shop makes to systems outside it. -/
inductive Call where
  | charge (order : String) (amount : Nat)
  | ship (order item : String)
deriving DecidableEq, Repr

abbrev Reply : Call → Type
  | .charge .. => Charge
  | .ship .. => Unit

inductive Name where
  | order
deriving DecidableEq, Repr

abbrev ShopAggregates : Aggregates where
  Name := Name
  of | .order => Order

abbrev ShopSignature : Signature where
  aggregates := ShopAggregates
  Call := Call
  Reply := Reply
  Saga := Unit
  SagaInput := Unit
  Signal := Unit
  Failure := Unit

/-- Whenever an order is placed, charge for it, and record what the gateway said. -/
def Payment : Policy ShopSignature :=
  .on "Payment" .order fun id event =>
    match event with
    | .placed _ amount => do
      match ← Program.request (σ := ShopSignature) (Call.charge id amount) with
      | .approved charge => Program.tell ⟨.order, (), .settle id charge⟩
      | .refused reason => Program.tell ⟨.order, (), .decline id reason⟩
    | _ => pure ()

/-- Whenever an order is paid, have the warehouse ship it. -/
def Fulfilment : Policy ShopSignature :=
  .on "Fulfilment" .order fun id event =>
    match event with
    | .paid _ item _ => Program.request (σ := ShopSignature) (Call.ship id item)
    | _ => pure ()

/-! ## What is read from it -/

/-- What one recorded event took in payment. -/
def taken : Emitted ShopAggregates → Nat
  | ⟨.order, _, .paid _ _ amount, _, _⟩ => amount
  | _ => 0

/-- A view: what the shop has taken, in total. -/
abbrev Revenue : View ShopAggregates where
  name := "Revenue"
  Key := Unit
  State := Nat
  Event := Empty
  Actor := Unit
  Rejection := Empty
  initial := 0
  on := fun _ event => [{ key := (), evolve := (· + taken event) }]

structure PackingRow where
  order : String
  item : String
deriving DecidableEq, Repr

/-- A projection: a row for the packers, written for each paid order. -/
def Packing : Projection ShopAggregates where
  name := "Packing"
  Row := PackingRow
  write
    | _, ⟨.order, id, .paid _ item _, _, _⟩ => [⟨id, item⟩]
    | _, _ => []

end Shop

open Shop in
/-- The shop: its aggregate, its policies and its reads. -/
abbrev Shop : Model where
  name := "Shop"
  signature := ShopSignature
  policies := [Payment, Fulfilment]
  views := [Revenue]
  projections := [Packing]

namespace Shop

/-! ## What is proved about the domain -/

/-- An order is charged at most once, and never more than it costs. -/
def ChargedOnce (s : State) : Prop :=
  (s.status = .new ∨ s.status = .awaitingPayment → s.charged = 0) ∧ s.charged ≤ s.amount

/-- No command an order accepts breaks the rule. -/
theorem chargedOnce_kept : Order.Keeps ChargedOnce := by
  aggregate_rule [Shop.decide, evolve, ChargedOnce]

/--
So it holds for every order in every world the shop can reach: whatever callers
send, whatever the gateway answers, in any order of delivery, with any event
delivered twice.
-/
theorem everyOrderChargedOnce (w : Alchemy.World ShopSignature) (reach : Shop.Reachable w)
    (id : String) : ChargedOnce (w.state .order id) :=
  Shop.always (P := fun | .order => ChargedOnce)
    (by intro n; cases n; simp [ChargedOnce])
    (by intro n; cases n; exact chargedOnce_kept)
    (by intro d mem; cases mem) w reach .order id

/-! ## What is proved about the reads -/

theorem revenue_go (history log : List (Emitted ShopAggregates)) (total : Nat) :
    Revenue.go () history log total = total + (log.map taken).sum := by
  induction log generalizing history total with
  | nil => rfl
  | cons event rest ih =>
    show Revenue.go () (history ++ [event]) rest (Revenue.applyAt history event () total) = _
    rw [ih]
    simp [View.applyAt]
    omega

/-- The Revenue view is exactly the sum of what was paid, whatever was recorded. -/
theorem revenueIsWhatWasPaid (log : List (Emitted ShopAggregates)) :
    Revenue.stateAt log () = (log.map taken).sum := by
  simpa [View.stateAt] using revenue_go [] log 0

def isPaid : Emitted ShopAggregates → Bool
  | ⟨.order, _, .paid .., _, _⟩ => true
  | _ => false

theorem packing_go (history log : List (Emitted ShopAggregates)) :
    (Packing.go history log).length = (log.filter isPaid).length := by
  induction log generalizing history with
  | nil => rfl
  | cons event rest ih =>
    obtain ⟨source, id, event, seq, time⟩ := event
    rw [Projection.go, List.length_append, ih]
    cases source; cases event <;> simp [Packing, isPaid, List.filter_cons] <;> omega

/-- The packers get one row for each paid order: none missed, none twice. -/
theorem everyPaidOrderIsPackedOnce (log : List (Emitted ShopAggregates)) :
    (Packing.table log).length = (log.filter isPaid).length :=
  packing_go [] log

/-- The domain by itself, with the outside systems played by the story. -/
example : Shop.passes [
    .when ⟨.order, (), .place "o-1" "kettle" 40⟩,
    .call (.charge "o-1" 40),
    .answer (.charge "o-1" 40) (.approved "ch_1"),
    .recorded .order "o-1" [.placed "kettle" 40, .paid "ch_1" "kettle" 40],
    .call (.ship "o-1" "kettle"),
    .answer (.ship "o-1" "kettle") (),
    .view Revenue () 40,
    .when ⟨.order, (), .settle "o-1" "ch_2"⟩,
    .rejected .order .notAwaitingPayment
  ] = true := by decide

/-! ## How the shop is spoken to -/

/-- Callers send order commands. Its history is written as JSON. -/
def served : Served Shop where
  Input := Command
  command := fun command => ⟨.order, (), command⟩

/--
The rule holds of the shop as deployed: whatever its journal holds, every
order it replays to was charged at most once.
-/
theorem deployedOrdersChargedOnce (journal : List String) (id : String) :
    ChargedOnce ((served.replay journal).state .order id) :=
  everyOrderChargedOnce _ (served.replay_reachable journal) id

/-! ## The stack -/

/-- A payment gateway that approves anything up to a limit. It touches no resource. -/
def sandboxCharge (order : String) (amount : Nat) (limit : Nat := 1000) : Charge :=
  if amount ≤ limit then .approved s!"ch_{order}" else .refused "over the limit"

def describe (order : State) : Response :=
  match order.status with
  | .new => { status := 404, body := "no such order" }
  | .awaitingPayment => { status := 202, body := "awaiting payment" }
  | .paid charge => { status := 200, body := s!"paid {charge}" }
  | .declined reason => { status := 402, body := reason }

/-- Takes orders. Hosts the shop: its history is in the bucket, and it ships through the queue. -/
def Api (orders : Bucket) (shipments : Queue) : Construct Kind Function :=
  Lambda.Function "Api" { url := true } do
    let journal ← S3.Journal orders
    let queue ← SQS.SendMessage shipments

    let shop := served.host journal fun
      | .charge order amount => pure (sandboxCharge order amount)
      | .ship order item => queue.call s!"{order}:{item}"

    return fun request => do
      match request.method, request.path, request.body.splitOn ":" with
      | .post, ["orders", id], [item, amount] =>
        let (answer, after) ← shop.send (.place id item amount.toNat!)
        match answer with
        | .ok _ => return describe (after.state .order id)
        | .error rejection => return { status := 409, body := reprStr rejection }
      | .get, ["orders", id], _ =>
        return describe ((← shop.world).state .order id)
      | .get, ["revenue"], _ =>
        return { status := 200, body := toString (Revenue.stateAt (← shop.world).log ()) }
      | _, _, _ => return { status := 404, body := "not found" }

/-- Consumes the shipments queue and files a packing slip for each. -/
def Packer (orders : Bucket) (shipments : Queue) : Construct Kind Function :=
  Lambda.Function "Packer" {} do
    let slips ← S3.PutObject orders ["packed"]

    SQS.consume shipments fun shipment => do
      match shipment.splitOn ":" with
      | [order, item] => slips.call order item
      | _ => pure ()

    return fun _ => return { status := 204 }

structure Outputs where
  api : Function
  packer : Function

def ShopStack : Stack Kind Outputs where
  name := "Shop"
  body := do
    let orders ← S3.Bucket "Orders"
    let shipments ← SQS.Queue "Shipments"
    let api ← Api orders shipments
    let packer ← Packer orders shipments
    return { api, packer }

def prod : Graph Kind := ShopStack.graph "prod"

def orders : Bucket := ⟨"Orders"⟩
def shipments : Queue := ⟨"Shipments"⟩
def api : Function := ⟨"Api"⟩
def packer : Function := ⟨"Packer"⟩

example : ShopStack.problem "prod" = none ∧ prod.deployable = true := by decide

example : prod.order = ["Orders", "Shipments", "Api", "Packer"] := by decide

/-! ## Stories: the whole stack, run in memory -/

abbrev Story := List (Graph.Step Kind InMemory)

def anOrder : Story := [
  .request api { method := .post, path := ["orders", "o-1"], body := "kettle:40" }
    (responds { status := 200, body := "paid ch_o-1" }),
  .holds "the packer filed a slip" (·.object orders ["packed", "o-1"] == some "kettle"),
  .holds "and took the shipment off the queue" (·.queued shipments == []),
  .request api { path := ["orders", "o-1"] } (responds { status := 200, body := "paid ch_o-1" }),
  .request api { method := .post, path := ["orders", "o-1"], body := "kettle:40" }
    (responds { status := 409, body := "Shop.Rejection.alreadyPlaced" }),
  .request api { path := ["revenue"] } (responds { status := 200, body := "40" }) ]

def anOrderTooLarge : Story := [
  .request api { method := .post, path := ["orders", "o-2"], body := "yacht:5000" }
    (responds { status := 402, body := "over the limit" }),
  .holds "nothing was packed" (·.object orders ["packed", "o-2"] == none) ]

example : prod.passes anOrder = true := by native_decide
example : prod.passes anOrderTooLarge = true := by native_decide

/-! ## What is proved about access -/

/-- Only the Api can write the shop's history. -/
theorem onlyTheApiWritesHistory (key : Path) (history : ["journal"] <+: key) (host : String)
    (can : host ∈ prod.whoCan ⟨.bucket, orders, BucketOp.put key⟩) : host = "Api" := by
  obtain ⟨rest, rfl⟩ := history
  access in prod using [BucketOp.covers, orders]
  grind

/-- The Packer can read nothing: no order, and none of the history. -/
theorem thePackerReadsNothing (key : Path) :
    prod.can "Packer" ⟨.bucket, orders, BucketOp.get key⟩ = false := by
  access in prod using [BucketOp.covers, orders]

/--
Least privilege: no function holds a grant it does not need. For each one there
is a run in which that function makes a call the grant is what permits.
-/
theorem leastPrivilege : prod.LeastPrivilege InMemory :=
  .of_stories [anOrder] (by native_decide)

/-! ## Deploying it -/

def fresh : Cloud.World Kind Control.Service := ⟨.empty, {}⟩

def deploy (g : Graph Kind) (w : Cloud.World Kind Control.Service) :
    Cloud.World Kind Control.Service × Bool :=
  apply Control.providers Control.Service g w

/-- The first deploy creates everything, each resource after what it needs. -/
example : plan Control.providers prod fresh.state = [
    ("Orders", .create), ("Shipments", .create), ("Api", .create), ("Packer", .create)] := by
  native_decide

/-- It succeeds, and deploying again has nothing to do. -/
example : (deploy prod fresh).2 = true ∧
    plan Control.providers prod (deploy prod fresh).1.state = [
      ("Orders", .noop), ("Shipments", .noop), ("Api", .noop), ("Packer", .noop)] := by
  native_decide

end Shop
