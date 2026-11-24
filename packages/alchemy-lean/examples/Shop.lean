import Alchemy

/-!
# A shop

One program, end to end: a domain model, the stack that hosts it, the rules
proved about both, and stories and tests the compiler runs.
-/

open Alchemy Cloud AWS

/-! ## The domain -/

inductive Order.Status where
  | new
  | awaitingPayment
  | paid (charge : String)
  | declined (reason : String)
deriving DecidableEq, Repr

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

  -- what a caller is told: where the order stands once the command is applied
  reply : Status
    | s, _ => s.status

aggregate Shipment where
  command
    | schedule (id item : String)
        records scheduled
        rejects alreadyScheduled

  event
    | scheduled (item : String)

  rejection
    | alreadyScheduled

  state
    item : Option String := none

  decide
    | s, .schedule _ item =>
      if s.item.isSome then .error .alreadyScheduled else .ok [.scheduled item]

  evolve
    | s, .scheduled item => { s with item := some item }

/-- What the payment gateway answers. -/
inductive Charge where
  | approved (id : String)
  | refused (reason : String)
deriving DecidableEq, Repr

derive_tokens Charge

model Shop where
  aggregate Order
  aggregate Shipment

  call charge (order : String) (amount : Nat) : Charge
  call ship (order item : String) : Unit

  -- whenever an order is placed, charge for it, and record what the gateway said
  policy Payment on Order
    | id, .placed _ amount => do
      match ← charge id amount with
      | .approved chargeId => Order.send (.settle id chargeId)
      | .refused reason => Order.send (.decline id reason)

  -- whenever an order is paid, schedule its shipment: one aggregate tells another
  policy Fulfilment on Order
    | id, .paid _ item _ => Shipment.send (.schedule id item)

  -- whenever a shipment is scheduled, have the warehouse ship it
  policy Dispatch on Shipment
    | id, .scheduled item => ship id item

  view Revenue on Order : Nat := 0
    | total, .paid _ _ amount => total + amount

  projection Packing on Shipment : String × String
    | id, .scheduled item => [(id, item)]

namespace Shop

/-! ## Behaviour, proved for every order

Each of these reads like a story: given what was recorded, when a command
arrives, then this happens. Unlike a story it holds for every id, item, amount
and charge, not for the one case written down.
-/

/-- Given a new order, when it is placed for a price, then it is recorded as placed. -/
theorem aNewOrderIsPlaced (id item : String) (amount : Nat) (priced : amount ≠ 0) :
    Order.decide (Order.after []) (.place id item amount) = .ok [.placed item amount] := by
  simp [Aggregate.after, Aggregate.apply, Order.decide, priced]

/-- Given a placed order, when it is placed again, then it is refused. -/
theorem anOrderIsPlacedOnce (id item again : String) (amount more : Nat) :
    Order.decide (Order.after [.placed item amount]) (.place id again more)
      = .error .alreadyPlaced := by
  simp [Aggregate.after, Aggregate.apply, Order.decide, Order.evolve]

/-- Given a placed order, when the gateway approves, then it is paid for exactly what it costs. -/
theorem settlingChargesWhatTheOrderCosts (id item charge : String) (amount : Nat) :
    Order.decide (Order.after [.placed item amount]) (.settle id charge)
      = .ok [.paid charge item amount] := by
  simp [Aggregate.after, Aggregate.apply, Order.decide, Order.evolve]

/-- Given a paid order, when a second charge arrives, then it is refused. -/
theorem aPaidOrderIsNeverChargedAgain (id item charge again : String) (amount : Nat) :
    Order.decide (Order.after [.placed item amount, .paid charge item amount]) (.settle id again)
      = .error .notAwaitingPayment := by
  simp [Aggregate.after, Aggregate.apply, Order.decide, Order.evolve]

/-- Given a declined order, when a charge arrives late, then it is refused. -/
theorem aDeclinedOrderIsNeverCharged (id item reason charge : String) (amount : Nat) :
    Order.decide (Order.after [.placed item amount, .declined reason]) (.settle id charge)
      = .error .notAwaitingPayment := by
  simp [Aggregate.after, Aggregate.apply, Order.decide, Order.evolve]

/-! ## General properties

Some facts are not about one scenario but about the shape of the aggregate.
-/

/--
Every order command is idempotent: sent twice in a row, it leaves what it
leaves sent once. So a caller who is not sure a command arrived can send it again.
-/
theorem everyOrderCommandIsIdempotent : Order.Idempotent := by
  command_law

theorem schedulingIsIdempotent : Shipment.Idempotent := by
  command_law

/-! ## Behaviour across the model

The same shape, but the "when" is now a run of the whole shop: commands sent,
policies reacting, and the outside systems answering.
-/

/--
Given a new order, when it is placed and the gateway approves the charge, then
it is paid and the warehouse is asked to ship it.
-/
theorem anApprovedOrderIsPaidAndShipped (id item charge : String) (amount : Nat)
    (priced : amount ≠ 0) :
    let shop := Shop.run [
      .send ⟨.Order, (), .place id item amount⟩,
      .answer (.charge id amount) (.approved charge)]
    (shop.state .Order id).status = .paid charge ∧
      (shop.state .Shipment id).item = some item ∧
      Shop.waiting shop = [.ship id item] := by
  behaviour

/--
Given a new order, when it is placed and the gateway refuses the charge, then
it is declined and nothing is shipped.
-/
theorem aRefusedOrderIsDeclinedAndNotShipped (id item reason : String) (amount : Nat)
    (priced : amount ≠ 0) :
    let shop := Shop.run [
      .send ⟨.Order, (), .place id item amount⟩,
      .answer (.charge id amount) (.refused reason)]
    (shop.state .Order id).status = .declined reason ∧
      (shop.state .Shipment id).item = none ∧
      Shop.waiting shop = [] := by
  behaviour

/-! ## Eventually

The theorems above say where a flow stands. These say it ends: left to run, the
shop comes to rest, with nothing in flight, and with the order where it should be.
-/

/--
Given a new order, when it is placed, the gateway approves and the warehouse
answers, then eventually the shop is at rest with nothing in flight, the order
paid and its shipment scheduled.
-/
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

/-- And when the gateway refuses, eventually the shop is at rest with the order declined. -/
theorem aRefusedOrderEventuallyEnds (id item reason : String) (amount : Nat)
    (priced : amount ≠ 0) :
    Shop.Eventually
      (Shop.run [
        .send ⟨.Order, (), .place id item amount⟩,
        .answer (.charge id amount) (.refused reason)])
      fun shop => shop.Settled ∧ (shop.state .Order id).status = .declined reason := by
  refine Shop.eventually_now _ ?_ ?_ <;> behaviour

/-! ### From any world

Those two are about one flow. This is about every world the shop can reach:
whatever was sent and answered, in any order, the shop left to run comes to rest.
It is proved with a measure: each event weighs more than the reactions to it,
each command at least what it records, so every step lowers the total.
-/

/-- Every reaction of the shop's policies only calls outside, tells an aggregate, and ends. -/
theorem policiesAreCalm : ∀ p ∈ Shop.policies, ∀ history e, Calm (p.react history e) := by
  intro p mem history e
  obtain ⟨source, id, event, seq, time⟩ := e
  simp only [List.mem_cons, List.mem_nil_iff, or_false] at mem
  rcases mem with rfl | rfl | rfl <;> cases source <;> cases event <;>
    first
      | exact .done
      | exact .tell _
      | exact .call _ _ (fun reply => by cases reply <;> first | exact .done | exact .tell _)

/-- What each event and each command weighs. -/
def weights : Shop.Weights where
  event
    | .Order, .placed .. => 3
    | .Order, .paid .. => 8
    | .Order, .declined _ => 4
    | .Shipment, .scheduled _ => 3
  send
    | ⟨.Order, _, .place ..⟩ => 3
    | ⟨.Order, _, .settle ..⟩ => 8
    | ⟨.Order, _, .decline ..⟩ => 4
    | ⟨.Shipment, _, .schedule ..⟩ => 3
  reacts := by
    intro history e
    obtain ⟨source, id, event, seq, time⟩ := e
    cases source <;> cases event <;>
      simp [Model.weigh, behaviour, Program.pure_eq, Program.bind_eq]
  emits := by
    intro n ctx state command es accepted
    cases n <;> cases command <;>
      simp only [Order.decide, Shipment.decide] at accepted <;>
      (repeat' split at accepted) <;> first | (cases accepted; simp) | cases accepted

/--
The shop comes to rest. From any world it can reach, left to run, it stops:
nothing more can happen without a caller, an outside answer or the clock.
-/
theorem theShopComesToRest (w : Alchemy.World Signature) (reach : Shop.Reachable w) :
    Shop.AtRest (Shop.settle (weights.measure w) w) :=
  weights.comesToRest policiesAreCalm w reach

/-! ## Rules about the domain -/

/-- An order is charged at most once, and never more than it costs. -/
def ChargedOnce (s : Order.State) : Prop :=
  (s.status = .new ∨ s.status = .awaitingPayment → s.charged = 0) ∧ s.charged ≤ s.amount

/-- No command an order accepts breaks the rule. -/
theorem chargedOnce : Order.Keeps ChargedOnce := by
  aggregate_rule

/--
So it holds for every order in every world the shop can reach: whatever callers
send, whatever the gateway answers, in any order of delivery, with any event
delivered twice.
-/
theorem everyOrderChargedOnce (w : Alchemy.World Signature) (reach : Shop.Reachable w)
    (id : String) : ChargedOnce (w.state .Order id) :=
  Order.always (by simp [ChargedOnce]) chargedOnce w reach id

/-- And of the shop as deployed: whatever its journal holds. -/
theorem deployedOrdersChargedOnce (journal : List Journal.Line) (id : String) :
    ChargedOnce ((served.replay journal).state .Order id) :=
  Order.deployed (by simp [ChargedOnce]) chargedOnce journal id

/-! These came with the model: nobody proved them here. -/

example (log : List (Emitted Aggregates)) :
    Revenue.stateAt log () = log.foldl Revenue.step 0 := Revenue.exact log

example (log : List (Emitted Aggregates)) :
    Packing.table log = log.flatMap Packing.rows := Packing.exact log

/-- One story, in the shop's words: a kettle is ordered, paid for and shipped, and cannot be ordered twice. -/
def aKettle : List (Story.ModelStep Shop) := [
  .when ⟨.Order, (), .place "o-1" "kettle" 40⟩,
  .call (.charge "o-1" 40),
  .answer (.charge "o-1" 40) (.approved "ch_o-1"),
  .recorded .Order "o-1" [.placed "kettle" 40, .paid "ch_o-1" "kettle" 40],
  .recorded .Shipment "o-1" [.scheduled "kettle"],
  .call (.ship "o-1" "kettle"),
  .answer (.ship "o-1" "kettle") (),
  .view Revenue () 40,
  .when ⟨.Order, (), .place "o-1" "kettle" 40⟩,
  .rejected .Order .alreadyPlaced ]

/-- Told to the domain by itself, with the story playing the outside systems. -/
example : Shop.passes aKettle = true := by decide

/-! ## The stack -/

/-- A payment gateway that approves anything up to a limit. It touches no resource. -/
def sandboxCharge (order : String) (amount : Nat) (limit : Nat := 1000) : Charge :=
  if amount ≤ limit then .approved s!"ch_{order}" else .refused "over the limit"

/-- An order's status, as a response. -/
def describe : Order.Status → Response
  | .new => { status := 404, body := "no such order" }
  | .awaitingPayment => { status := 202, body := "awaiting payment" }
  | .paid charge => { status := 200, body := s!"paid {charge}" }
  | .declined reason => { status := 402, body := reason }

/-! The Api's routes, each a function of the hosted shop. -/

section Routes
variable {role : Access Kind} (shop : Hosted served role)

/-- What the Api says about a command: its rejection, or the order's reply. -/
def respond : Except Order.Rejection Order.Status → Response
  | .ok status => describe status
  | .error rejection => { status := 409, body := reprStr rejection }

/-- `POST /orders`: the command's reply is the response. -/
def postOrder (command : Order.Command) : Run role Never Response := do
  return respond (← shop.ask (.Order command))

/-- `GET /orders/{id}` -/
def getOrder (id : String) : Run role Never Response := do
  return describe ((← shop.world).state .Order id).status

/-- `GET /revenue` -/
def getRevenue : Run role Never Response := do
  return { status := 200, body := toString (Revenue.stateAt (← shop.world).log ()) }

def route (request : Request) : Run role Never Response :=
  match request.method, request.path with
  | .post, ["orders"] =>
    match Text.read (α := Order.Command) request.body with
    | some command => postOrder shop command
    | none => pure { status := 400, body := "not a command" }
  | .get, ["orders", id] => getOrder shop id
  | .get, ["revenue"] => getRevenue shop
  | _, _ => pure { status := 404, body := "not found" }

end Routes

-- The shop, hosted: its history is a journal in the bucket, and each call it
-- makes to the outside is answered here. Charging goes to a sandbox gateway;
-- shipping is a message on the queue. What it needs is read off its body.
helper theShop {role : Access Kind} (orders : Bucket) (shipments : Queue) : Hosted served role :=
  served.host (S3.journal orders) fun
    | .charge order amount => pure (sandboxCharge order amount)
    | .ship order item => SQS.sendMessage shipments s!"{order}:{item}"

/-- Takes orders. Hosts the shop: its history is in the bucket, and it ships through the queue. -/
def Api (orders : Bucket) (shipments : Queue) : Construct Kind Function := do
  let stage ← stage
  Lambda.Function "Api" { url := true, memory := if stage = "prod" then 1024 else 512 } do
    return route (theShop orders shipments)

/-- Consumes the shipments queue and files a packing slip for each. -/
def Warehouse (orders : Bucket) (shipments : Queue) : Construct Kind Function :=
  Lambda.Function "Warehouse" {} do
    SQS.consume shipments fun shipment => do
      match shipment.splitOn ":" with
      | [order, item] => S3.putObject orders ["packed"] order item
      | _ => pure ()

    return fun _ => return { status := 204 }

structure Outputs where
  orders : Bucket
  shipments : Queue
  api : Function
  warehouse : Function
deriving Inhabited

def ShopStack : Stack Kind Outputs where
  name := "Shop"
  body := do
    let orders ← S3.Bucket "Orders"
    let shipments ← SQS.Queue "Shipments"
    let api ← Api orders shipments
    let warehouse ← Warehouse orders shipments
    return { orders, shipments, api, warehouse }

def prod : Graph Kind := ShopStack.graph "prod"

/-- What the stack built, for tests and theorems to name. -/
@[stack_facts] def out : Outputs := computed% (ShopStack.outputs "prod")

example : ShopStack.problem "prod" = none ∧ prod.deployable = true := by decide

example : prod.order = ["Orders", "Shipments", "Api", "Warehouse"] := by decide

/-! ## Behaviour of the Api, for every request

The same shape as the domain's behaviour theorems, one level out: given what the
bucket holds, when a request arrives, then this is the response and this is what
the bucket holds afterwards. Proved from the laws of the bindings.
-/

section ApiBehaviour

variable {role : Access Kind} {orders : Bucket} {shipments : Queue}
  [theShop.Needs role orders shipments]

/-- The shop as a bucket has it: what its journal replays to. -/
abbrev shopIn (orders : Bucket) (cloud : Memory) : Alchemy.World Signature :=
  served.replay (S3.lines orders ["journal"] cloud)

/-- A bucket whose journal is whole: every line it counts is there. -/
abbrev Whole (orders : Bucket) (cloud : Memory) : Prop := S3.Sound orders ["journal"] cloud

/--
Given any bucket, when an order is asked for, then the Api describes that order
as the journal has it, and changes nothing.
-/
theorem gettingAnOrder (id : String) (cloud : Memory) :
    (getOrder (theShop (role := role) orders shipments) id).eval InMemory cloud
      = (.ok (describe ((shopIn orders cloud).state .Order id).status), cloud) := by
  show Run.eval InMemory (Run.bind _ _) cloud = _
  rw [Run.eval_bind, Hosted.world_eval _ (S3.journal_lawful orders ["journal"])]
  rfl

/-- Given any bucket, when the revenue is asked for, then the Api answers the Revenue view, and changes nothing. -/
theorem gettingTheRevenue (cloud : Memory) :
    (getRevenue (theShop (role := role) orders shipments)).eval InMemory cloud
      = (.ok { status := 200, body := toString (Revenue.stateAt (shopIn orders cloud).log ()) },
          cloud) := by
  show Run.eval InMemory (Run.bind _ _) cloud = _
  rw [Run.eval_bind, Hosted.world_eval _ (S3.journal_lawful orders ["journal"])]
  rfl

/-- What a caller of an order command is told, in the order's own terms. -/
theorem answered_order (command : Order.Command) (before after : Alchemy.World Signature) :
    Hosted.answered (served.command (.Order command))
        (before.toRecorded.outcome before.now (served.command (.Order command))) after
      = (Order.decide (before.state .Order (Order.key command)) command).map
          fun _ => Order.reply (after.state .Order (Order.key command)) command := rfl

/--
Given a bucket whose journal is whole, when a command is posted, then the Api
answers what the order, as the journal had it, decides: a refusal as a 409, and
otherwise the order's reply from the state the journal has now. The journal is
whole afterwards.
-/
theorem postingACommand (command : Order.Command) (cloud : Memory) (whole : Whole orders cloud) :
    ((postOrder (theShop (role := role) orders shipments) command).eval InMemory cloud).1
      = .ok (respond
        ((Order.decide ((shopIn orders cloud).state .Order (Order.key command)) command).map
          fun _ => Order.reply
            ((shopIn orders
              ((postOrder (theShop (role := role) orders shipments) command).eval InMemory cloud).2).state
              .Order (Order.key command)) command)) ∧
      Whole orders
        ((postOrder (theShop (role := role) orders shipments) command).eval InMemory cloud).2 := by
  have asked := Hosted.ask_recorded (sim := InMemory) (lines := S3.lines orders ["journal"])
    (sound := S3.Sound orders ["journal"]) (theShop (role := role) orders shipments)
    (S3.journal_lawful orders ["journal"]) served.faithful
    (by
      intro call cloud whole
      cases call with
      | charge order amount => exact ⟨rfl, whole⟩
      | ship order item =>
        refine S3.quiet _ cloud (fun key => ?_) whole
        show ((SQS.sendMessage (role := role) shipments s!"{order}:{item}").eval InMemory cloud).2.object
          orders key = _
        rw [SQS.sendMessage_eval]
        rfl)
    (.Order command) cloud whole
  have evaluated : (postOrder (theShop (role := role) orders shipments) command).eval InMemory cloud
      = (.ok (respond (Hosted.answered (served.command (.Order command))
            ((shopIn orders cloud).toRecorded.outcome (shopIn orders cloud).now
              (served.command (.Order command)))
            (shopIn orders ((Hosted.ask (theShop (role := role) orders shipments)
              (.Order command)).eval InMemory cloud).2))),
        ((Hosted.ask (theShop (role := role) orders shipments) (.Order command)).eval InMemory cloud).2) := by
    show Run.eval InMemory (Run.bind _ _) cloud = _
    rw [Run.eval_bind, asked.1]
    rfl
  rw [evaluated]
  exact ⟨congrArg (fun told => Except.ok (respond told)) (answered_order command _ _), asked.2⟩

/--
Given a bucket in which an order is already placed, when it is placed again,
then the Api refuses with a 409, whatever the item and the amount.
-/
theorem placingAnOrderTwiceIsRefused (id item : String) (amount : Nat) (cloud : Memory)
    (whole : Whole orders cloud)
    (placed : ((shopIn orders cloud).state .Order id).status ≠ .new) :
    ((postOrder (theShop (role := role) orders shipments) (.place id item amount)).eval InMemory cloud).1
      = .ok { status := 409, body := reprStr Order.Rejection.alreadyPlaced } := by
  have answered := (postingACommand (role := role) (shipments := shipments)
    (.place id item amount) cloud whole).1
  simp only [respond, Order.decide, Order.key, placed, ne_eq, not_false_eq_true, ite_true,
    Except.map] at answered
  exact answered

/-- A posted body that reads as a command reaches the route for that command. -/
theorem postingReachesTheCommand (body : String) (command : Order.Command)
    (reads : Text.read (α := Order.Command) body = some command) :
    route (theShop (role := role) orders shipments) { method := .post, path := ["orders"], body }
      = postOrder (theShop (role := role) orders shipments) command := by
  simp [route, reads]

/-- A posted body that does not read as a command is refused, and nothing is touched. -/
theorem aMalformedBodyIsRefused (body : String)
    (unreadable : Text.read (α := Order.Command) body = none) (cloud : Memory) :
    (route (theShop (role := role) orders shipments)
        { method := .post, path := ["orders"], body }).eval InMemory cloud
      = (.ok { status := 400, body := "not a command" }, cloud) := by
  simp only [route, unreadable]
  rfl

/-- The routes are the requests: each request reaches the route its path names. -/
example (id : String) :
    route (theShop (role := role) orders shipments) { method := .get, path := ["orders", id] }
      = getOrder (theShop (role := role) orders shipments) id := rfl

end ApiBehaviour

/-! ## Stories, told to the stack

The same kind of story as the domain's, in the same words. Here each command
goes in through the Api, the gateway and the queue answer the shop's calls, and
what is recorded is read back from the journal in the bucket.
-/

/-- How the stack is told a story: commands are posted to the Api, and the shop is read from the bucket. -/
def deployed : Telling Shop InMemory where
  kind := .function
  host := out.api
  request
    | ⟨.Order, _, command⟩ => (post out.api "/orders" command).request
    | ⟨.Shipment, _, command⟩ => (post out.api "/shipments" command).request
  world := shopIn out.orders

/-- The same story as the domain's, word for word, told to the stack. -/
example : prod.tells deployed aKettle = true := by native_decide

/-- And one the stack decides for itself: its gateway refuses an order over its limit. -/
example : prod.tells deployed [
    .when ⟨.Order, (), .place "o-2" "yacht" 5000⟩,
    .recorded .Order "o-2" [.placed "yacht" 5000, .declined "over the limit"],
    .view Revenue () 0
  ] = true := by native_decide

/-! ## Tests of the stack

These are not stories: they speak HTTP and buckets, not the shop's language.
They check the wiring end to end, in memory.
-/

def postingAnOrder : List (Graph.Step Kind InMemory) := [
  post out.api "/orders" (Order.Command.place "o-1" "kettle" 40) ⇒ (200, "paid ch_o-1"),
  .holds "the warehouse filed a slip" (·.object out.orders ["packed", "o-1"] == some "kettle"),
  .holds "and took the shipment off the queue" (·.queued out.shipments == []),
  get out.api "/orders/o-1" ⇒ (200, "paid ch_o-1"),
  post out.api "/orders" (Order.Command.place "o-1" "kettle" 40)
    ⇒ (409, "Order.Rejection.alreadyPlaced"),
  get out.api "/revenue" ⇒ (200, "40") ]

def postingAnOrderTooLarge : List (Graph.Step Kind InMemory) := [
  post out.api "/orders" (Order.Command.place "o-2" "yacht" 5000) ⇒ (402, "over the limit"),
  .holds "nothing was packed" (·.object out.orders ["packed", "o-2"] == none) ]

example : prod.passes postingAnOrder = true := by native_decide
example : prod.passes postingAnOrderTooLarge = true := by native_decide

/-! ## What is proved about access -/

/-- Only the Api writes the shop's history. -/
theorem onlyTheApiWritesHistory :
    prod.only [out.api] (S3.writing out.orders ["journal"]) := by
  stack_rule in prod

/-- Only the Warehouse files packing slips. -/
theorem onlyTheWarehouseFilesSlips :
    prod.only [out.warehouse] (S3.writing out.orders ["packed"]) := by
  stack_rule in prod

/-- The Warehouse reads nothing in the bucket: no order, and none of the history. -/
theorem theWarehouseReadsNothing :
    prod.never out.warehouse (S3.reading out.orders) := by
  stack_rule in prod

/-- Nothing can list the bucket. -/
theorem nobodyListsTheOrders : prod.nobody (S3.listing out.orders) := by
  stack_rule in prod

/-- Only the Api asks for a shipment, and only the Warehouse takes one. -/
theorem shipmentsGoOneWay :
    prod.only [out.api] (SQS.sending out.shipments) ∧
      prod.only [out.warehouse] (SQS.receiving out.shipments) := by
  constructor <;> stack_rule in prod

/-- Neither function can invoke the other. -/
theorem noFunctionInvokesAnother (function : Function) :
    prod.nobody (Lambda.invoking function) := by
  stack_rule in prod

/-- The Api can read back all of the history it writes. -/
theorem theApiReadsItsHistory :
    prod.may out.api (S3.reading out.orders ["journal"]) := by
  stack_rule in prod

/--
Least privilege: no function holds a grant it does not need. For each one there
is a run in which that function makes a call the grant is what permits.
-/
theorem leastPrivilege : prod.LeastPrivilege InMemory :=
  .of_tests [postingAnOrder] (by native_decide)

/-! ## Deploying it -/

def fresh : Cloud.World Kind Control.Service := ⟨.empty, {}⟩

def deploy (g : Graph Kind) (w : Cloud.World Kind Control.Service) :
    Cloud.World Kind Control.Service × Bool :=
  apply Control.providers Control.Service g w

/-- The first deploy creates everything, each resource after what it needs. -/
example : plan Control.providers prod fresh.state = [
    ("Orders", .create), ("Shipments", .create), ("Api", .create), ("Warehouse", .create)] := by
  native_decide

/-- It succeeds, and deploying again has nothing to do. -/
example : (deploy prod fresh).2 = true ∧
    plan Control.providers prod (deploy prod fresh).1.state = [
      ("Orders", .noop), ("Shipments", .noop), ("Api", .noop), ("Warehouse", .noop)] := by
  native_decide

end Shop
