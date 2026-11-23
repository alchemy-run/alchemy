import Alchemy
import Bank.Views

open Alchemy

namespace Bank

/-! ## Ledger: every money movement, written to a store outside the model -/

structure LedgerRow where
  /-- Where the event sits in the log, so a replay writes the same row. -/
  id : Nat
  accountId : AccountId
  kind : LineKind
  amount : Cents
  balanceAfter : Cents
  time : Time
deriving DecidableEq, Repr

def Ledger : Projection BankAggregates where
  name := "Ledger"
  Row := LedgerRow
  write
    | _, ⟨.account, id, event, seq, time⟩ =>
      (lineOf event).map fun line => ⟨seq, id, line.kind, line.amount, line.balance, time⟩
    | _, _ => []

/-- What a log gives the ledger: a row for each statement line of each account event. -/
theorem ledger_go (state : States BankAggregates) (history log : List (Emitted BankAggregates)) :
    (Ledger.go history log).length
      = (((Recorded.mk state log).eventsOf .account).map fun event => (lineOf event).length).sum := by
  induction log generalizing history with
  | nil => rfl
  | cons e rest ih =>
    obtain ⟨source, id, event, seq, time⟩ := e
    rw [Projection.go, List.length_append, ih]
    cases source <;> simp [Recorded.eventsOf, Ledger]

/--
The ledger is given every money movement the accounts record, whatever the bank
did: it has exactly one row for each statement line of each account event.
-/
theorem ledgerIsGivenEveryMovement (r : Recorded BankAggregates) :
    (Ledger.table r.log).length = (((r.eventsOf .account).map fun event => (lineOf event).length).sum) :=
  ledger_go r.state [] r.log

/-- One account's ledger, oldest first. Its owner and agents read it. -/
def AccountLedger : Query BankAggregates where
  name := "AccountLedger"
  Input := AccountId
  Row := LedgerRow
  Actor := Actor
  Rejection := AccountRejection
  handle := fun actor log account =>
    (mustOwn actor (AccountSummary.stateAt log account).customerId).map fun _ =>
      (Ledger.table log).filter (·.accountId = account)

/-! ## AccountCard: a log per account that clients follow -/

structure CardChanged where
  customerId : CustomerId
  owner : String
  balance : Cents
  frozen : Bool
deriving DecidableEq, Repr

def changesTheCard : AccountEvent → Bool
  | .moneyDeposited .. | .moneyWithdrawn .. | .transferDebited .. | .transferCredited ..
  | .transferRefunded .. | .settlementReceived .. | .accountFrozen .. => true
  | _ => false

/-- The AccountCards projection appends a card on every change to the summary. -/
def AccountCard : Stream BankAggregates where
  name := "AccountCard"
  Key := AccountId
  Entry := CardChanged
  Actor := Actor
  Rejection := AccountRejection
  append
    | history, e@⟨.account, id, event, _, _⟩ =>
      let summary := AccountSummary.stateAt (history ++ [e]) id
      match changesTheCard event, summary.customerId, summary.owner with
      | true, some customerId, some owner =>
        [(id, ⟨customerId, owner, summary.balance, summary.frozen⟩)]
      | _, _, _ => []
    | _, _ => []
  validate := fun actor _ latest => mustOwn actor (latest.map (·.customerId))

end Bank
