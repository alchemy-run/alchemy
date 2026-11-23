import Alchemy
import Bank.Shape

open Alchemy

namespace Bank

abbrev Recorded' := Emitted BankAggregates

/-- Customers read what is theirs; agents read anything. Nobody owns what nobody opened. -/
def mustOwn (actor : Actor) (owner : Option CustomerId) : Except AccountRejection Unit :=
  match actor, owner with
  | .agent _, _ => .ok ()
  | _, none => .ok ()
  | .customer customerId, some owner => if customerId = owner then .ok () else .error .notOwner
  | _, some _ => .error .notOwner

/-! ## AccountSummary -/

structure Summary where
  customerId : Option CustomerId := none
  owner : Option String := none
  balance : Cents := 0
  frozen : Bool := false
  closed : Bool := false
deriving DecidableEq, Repr

def summarize (v : Summary) : AccountEvent → Summary
  | .accountOpened customerId owner => { v with customerId := some customerId, owner := some owner }
  | .ownerChanged _ customerId _ => { v with customerId := some customerId }
  | .moneyDeposited _ balance => { v with balance }
  | .moneyWithdrawn _ balance => { v with balance }
  | .transferDebited _ _ balance => { v with balance }
  | .transferCredited _ _ balance => { v with balance }
  | .transferRefunded _ _ balance => { v with balance }
  | .settlementReceived _ _ balance => { v with balance }
  | .accountFrozen .. => { v with frozen := true }
  | .accountClosed => { v with closed := true }
  | _ => v

/-- An account at a glance. Its owner and agents read it. -/
def AccountSummary : View BankAggregates where
  name := "AccountSummary"
  Key := AccountId
  State := Summary
  Event := Empty
  Actor := Actor
  Rejection := AccountRejection
  initial := {}
  on
    | _, ⟨.account, id, event, _, _⟩ => [{ key := id, evolve := fun v => summarize v event }]
    | _, _ => []
  validate := fun actor _ summary => mustOwn actor summary.customerId

/-! ## Statement -/

inductive LineKind where
  | deposit | withdrawal | transferIn | transferOut | refund | settlement
deriving DecidableEq, Repr

structure StatementLine where
  kind : LineKind
  amount : Cents
  balance : Cents
deriving DecidableEq, Repr

def lineOf : AccountEvent → List StatementLine
  | .moneyDeposited amount balance => [⟨.deposit, amount, balance⟩]
  | .moneyWithdrawn amount balance => [⟨.withdrawal, amount, balance⟩]
  | .transferCredited _ amount balance => [⟨.transferIn, amount, balance⟩]
  | .transferDebited _ amount balance => [⟨.transferOut, amount, balance⟩]
  | .transferRefunded _ amount balance => [⟨.refund, amount, balance⟩]
  | .settlementReceived _ amount balance => [⟨.settlement, amount, balance⟩]
  | _ => []

def ownerAfter (owner : Option CustomerId) : AccountEvent → Option CustomerId
  | .accountOpened customerId _ => some customerId
  | .ownerChanged _ customerId _ => some customerId
  | _ => owner

/-- An account's money events as statement lines. -/
def Statement : View BankAggregates where
  name := "Statement"
  Key := AccountId
  State := Option CustomerId
  Event := StatementLine
  Actor := Actor
  Rejection := AccountRejection
  initial := none
  on
    | _, ⟨.account, id, event, _, _⟩ =>
      [{ key := id, evolve := fun owner => ownerAfter owner event, emit := fun _ _ => lineOf event }]
    | _, _ => []
  validate := fun actor _ owner => mustOwn actor owner

/-! ## AccountActivity -/

def activityOf : AccountEvent → List AccountEvent
  | e@(.accountFrozen ..) | e@(.accountClosed) | e@(.ownerChanged ..) | e@(.refundStranded ..)
  | e@(.settlementOnClosedAccount ..) => [e]
  | _ => []

/-- What support needs to see about an account. Agents only. -/
def AccountActivity : View BankAggregates where
  name := "AccountActivity"
  Key := AccountId
  State := Unit
  Event := AccountEvent
  Actor := Actor
  Rejection := String
  initial := ()
  on
    | _, ⟨.account, id, event, _, _⟩ =>
      [{ key := id, evolve := fun u => u, emit := fun _ _ => activityOf event }]
    | _, _ => []
  validate := fun actor _ _ =>
    match actor with
    | .agent _ => .ok ()
    | _ => .error "account activity is for agents"

/-! ## CustomerDashboard -/

structure Dashboard where
  name : Option String := none
  balances : List (AccountId × Cents) := []
deriving DecidableEq, Repr

def Dashboard.without (d : Dashboard) (id : AccountId) : Dashboard :=
  { d with balances := d.balances.filter (·.1 ≠ id) }

def Dashboard.withBalance (d : Dashboard) (id : AccountId) (balance : Cents) : Dashboard :=
  { d with balances := (d.without id).balances ++ [(id, balance)] }

def Dashboard.totalBalance (d : Dashboard) : Cents :=
  (d.balances.map (·.2)).sum

/--
A customer's accounts and balances, built from the customer's events and from
AccountSummary after each account event. An ownership change moves the account
between dashboards.
-/
def CustomerDashboard : View BankAggregates where
  name := "CustomerDashboard"
  Key := CustomerId
  State := Dashboard
  Event := Empty
  Actor := Actor
  Rejection := String
  initial := {}
  on
    | _, ⟨.customer, id, .customerRegistered name _, _, _⟩ =>
      [{ key := id, evolve := fun d => { d with name := some name } }]
    | history, e@⟨.account, id, event, _, _⟩ =>
      let summary := AccountSummary.stateAt (history ++ [e]) id
      match event, summary.customerId with
      | .ownerChanged previous current _, _ =>
        [ { key := previous, evolve := fun d => d.without id },
          { key := current, evolve := fun d => d.withBalance id summary.balance } ]
      | _, some customerId =>
        [{ key := customerId
           evolve := fun d =>
             if summary.closed then d.without id else d.withBalance id summary.balance }]
      | _, none => []
    | _, _ => []
  validate := fun actor key _ =>
    match actor with
    | .agent _ => .ok ()
    | .customer customerId =>
      if customerId = key then .ok () else .error "that is not your dashboard"
    | _ => .error "that is not your dashboard"

/-! ## TransferStatus -/

structure Status where
  source : Option AccountId := none
  destination : Option AccountId := none
  amount : Option Cents := none
  requestedBy : Option Actor := none
  awaitingApproval : Bool := false
  debited : Bool := false
  credited : Bool := false
  refunded : Bool := false
  completedAt : Option Time := none
  failedReason : Option String := none
deriving DecidableEq, Repr

inductive Progress where
  | completed | failed | inFlight | awaitingApproval | pending
deriving DecidableEq, Repr

def Status.progress (v : Status) : Progress :=
  if v.completedAt.isSome then .completed
  else if v.failedReason.isSome then .failed
  else if v.debited then .inFlight
  else if v.awaitingApproval then .awaitingApproval
  else .pending

/-- Where a transfer stands, from the transfer's events and both accounts'. -/
def TransferStatus : View BankAggregates where
  name := "TransferStatus"
  Key := TransferId
  State := Status
  Event := Empty
  Actor := Actor
  Rejection := AccountRejection
  initial := {}
  on
    | _, ⟨.transfer, id, event, _, time⟩ =>
      [{ key := id
         evolve := fun v =>
           match event with
           | .transferRequested details needsApproval =>
             { v with
               source := some details.source, destination := some details.destination,
               amount := some details.amount, requestedBy := some details.requestedBy,
               awaitingApproval := needsApproval }
           | .transferApproved .. => { v with awaitingApproval := false }
           | .transferCompleted => { v with completedAt := some time }
           | .transferFailed reason =>
             { v with awaitingApproval := false, failedReason := some reason } }]
    | _, ⟨.account, _, .transferDebited id _ _, _, _⟩ =>
      [{ key := id, evolve := fun v => { v with debited := true } }]
    | _, ⟨.account, _, .transferCredited id _ _, _, _⟩ =>
      [{ key := id, evolve := fun v => { v with credited := true } }]
    | _, ⟨.account, _, .transferRefunded id _ _, _, _⟩ =>
      [{ key := id, evolve := fun v => { v with refunded := true } }]
    | _, _ => []
  validate := fun actor _ status =>
    match actor, status.requestedBy with
    | .agent _, _ => .ok ()
    | _, none => .ok ()
    | .customer customerId, some (.customer requester) =>
      if customerId = requester then .ok () else .error .notOwner
    | _, _ => .error .notOwner

/-! ## AccountTransfers -/

inductive Direction where
  | incoming | outgoing
deriving DecidableEq, Repr

structure TransferMoved where
  transferId : TransferId
  amount : Cents
  direction : Direction
deriving DecidableEq, Repr

/-- The transfers in and out of an account: one transfer shows on both accounts. -/
def AccountTransfers : View BankAggregates where
  name := "AccountTransfers"
  Key := AccountId
  State := Option CustomerId
  Event := TransferMoved
  Actor := Actor
  Rejection := AccountRejection
  initial := none
  on
    | _, ⟨.account, id, event, _, _⟩ =>
      [{ key := id, evolve := fun owner => ownerAfter owner event }]
    | _, ⟨.transfer, id, .transferRequested details _, _, _⟩ =>
      [ { key := details.source, evolve := fun owner => owner,
          emit := fun _ _ => [⟨id, details.amount, .outgoing⟩] },
        { key := details.destination, evolve := fun owner => owner,
          emit := fun _ _ => [⟨id, details.amount, .incoming⟩] } ]
    | _, _ => []
  validate := fun actor _ owner => mustOwn actor owner

/-! ## DailyOutflow -/

/-- Daily outflow above which an account's activity is reviewed, in cents. -/
def reviewThreshold : Cents := 50000

structure Outflow where
  day : Nat := 0
  total : Cents := 0
deriving DecidableEq, Repr

/-- An account's money out today crossed the review threshold. -/
structure DailyOutflowExceeded where
  day : Nat
  total : Cents
deriving DecidableEq, Repr

def Outflow.add (s : Outflow) (amount : Cents) (time : Time) : Outflow :=
  { day := dayOf time, total := (if s.day = dayOf time then s.total else 0) + amount }

def crossed (before after : Outflow) : List DailyOutflowExceeded :=
  if before.total < reviewThreshold ∧ after.total ≥ reviewThreshold then
    [⟨after.day, after.total⟩]
  else []

def outflowOf : AccountEvent → Option Cents
  | .moneyWithdrawn amount _ => some amount
  | .transferDebited _ amount _ => some amount
  | _ => none

/--
Money out of an account per day. It emits an event when the day's total crosses
the threshold, so split withdrawals are caught too.
-/
def DailyOutflow : View BankAggregates where
  name := "DailyOutflow"
  Key := AccountId
  State := Outflow
  Event := DailyOutflowExceeded
  Actor := Actor
  Rejection := Empty
  initial := {}
  on
    | _, ⟨.account, id, event, _, time⟩ =>
      match outflowOf event with
      | some amount => [{ key := id, evolve := fun s => s.add amount time, emit := crossed }]
      | none => []
    | _, _ => []

end Bank
