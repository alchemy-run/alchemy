import Alchemy
import Bank.Model
import Bank.Stories

open Alchemy

namespace Bank

/-!
Rules about the bank as a whole, once it has settled. These are checked in every
sequence of the moves below up to a depth, not proved for ever: `native_decide`
runs the search with compiled code.
-/

/-- What callers, outside systems and the clock do in the sequences searched. -/
def moves : List (Model.Move Bank) := [
  .decide Registration sam ⟨"c-1", "Sam", "sam"⟩,
  .decide Registration alex ⟨"c-2", "Alex", "alex"⟩,
  .send ⟨.account, sam, .deposit ⟨"c-1-main", 30000⟩⟩,
  .send ⟨.transfer, sam, .request ⟨"t-1", "c-1-main", "c-2-main", 100⟩⟩,
  .send ⟨.transfer, sam, .request ⟨"t-2", "c-1-main", "c-2-main", 20000⟩⟩,
  .send ⟨.transfer, support, .approve ⟨"t-2"⟩⟩,
  .send ⟨.account, alex, .close ⟨"c-2-main"⟩⟩,
  .pass 86400 ]

def sum (amounts : List Cents) : Cents := amounts.foldl (· + ·) 0

/-- Every cent a transfer takes out of an account is paid into another, paid back, or recorded as stranded. -/
def moneyIsAccountedFor (w : World BankSignature) : Bool :=
  let events := w.toRecorded.eventsOf .account
  let taken := sum (events.filterMap fun
    | .transferDebited _ amount _ => some amount
    | _ => none)
  let given := sum (events.filterMap fun
    | .transferCredited _ amount _ | .transferRefunded _ amount _ | .refundStranded _ amount =>
      some amount
    | _ => none)
  taken = given

/-- A transfer that may run has run: it completed or it failed. -/
def nothingLeftPending (w : World BankSignature) : Bool :=
  (w.toRecorded.ids .transfer).all fun id =>
    match w.state .transfer id with
    | .pending _ => false
    | _ => true

/-- The ledger is given every deposit the accounts record. -/
def ledgerIsGivenEveryDeposit (w : World BankSignature) : Bool :=
  ((Ledger.table w.log).filter (·.kind = .deposit)).length =
    ((w.toRecorded.eventsOf .account).filter (· matches .moneyDeposited ..)).length

/-- Once the approval window has closed, every transfer has ended. -/
def endsOnceTheWindowCloses (w : World BankSignature) : Bool :=
  let later := Bank.play 1000 w (.pass approvalWindow)
  (later.toRecorded.ids .transfer).all fun id =>
    match later.state .transfer id with
    | .completed | .failed _ => true
    | _ => false

/-- A customer has money in an account. -/
def anAccountHoldsMoney (w : World BankSignature) : Bool :=
  (w.toRecorded.ids .account).any fun id =>
    match w.state .account id with
    | .opened account => account.balance > 0
    | _ => false

theorem transfersLoseNoMoney_checked : Bank.checked moves 4 moneyIsAccountedFor = true := by
  native_decide

theorem noTransferLeftPending_checked : Bank.checked moves 4 nothingLeftPending = true := by
  native_decide

theorem ledgerIsGivenEveryDeposit_checked :
    Bank.checked moves 4 ledgerIsGivenEveryDeposit = true := by
  native_decide

/-- Eventually: no transfer waits for ever, because one nobody approves expires. -/
theorem everyTransferEnds_checked : Bank.checked moves 4 endsOnceTheWindowCloses = true := by
  native_decide

/-- The same moves, with events delivered to the policies a second time. -/
def movesWithRedelivery : List (Model.Move Bank) :=
  moves ++ [.redeliver 0, .redeliver 3, .redeliver 5]

/-- Delivering an event twice loses no money and leaves no transfer pending. -/
theorem redeliveryLosesNoMoney_checked :
    Bank.checked movesWithRedelivery 4
      (fun w => moneyIsAccountedFor w && nothingLeftPending w) = true := by
  native_decide

/-- Sometimes: the bank can be used. -/
theorem anAccountHoldsMoney_sometimes : Bank.sometimes moves 3 anAccountHoldsMoney = true := by
  native_decide

/--
Sometimes, proved: there is a world the bank can reach where a customer has
money. The witness is a story: Sam registers, then deposits.
-/
theorem anAccountCanHoldMoney : ∃ w, Bank.Reachable w ∧ anAccountHoldsMoney w = true := by
  let registered :=
    Bank.settle 1000 ((World.start BankSignature).decide Registration sam ⟨"c-1", "Sam", "sam"⟩)
  let deposited :=
    Bank.settle 1000 (registered.dispatch ⟨.account, sam, .deposit ⟨"c-1-main", 100⟩⟩)
  refine ⟨deposited, ?_, by decide⟩
  refine Bank.settle_reachable _ _ (.step ?_ (.send _ _ trivial))
  exact Bank.settle_reachable _ _ (.step .start (.decide _ _ _ _ (by simp)))

/--
A rule that is false gives the shortest sequence that breaks it. "No transfer
ever waits for approval" breaks after one move: Sam asks to move 20,000.
-/
example :
    Bank.counterexample moves 4
      (fun w => (w.toRecorded.ids .transfer).all fun id =>
        !(w.state .transfer id matches .awaitingApproval _))
      = some [4] := by
  native_decide

end Bank
