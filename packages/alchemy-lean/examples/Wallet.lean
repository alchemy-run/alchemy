import Alchemy

/-!
# A wallet

The smallest whole example: one aggregate, one rule proved about it, and one
story the compiler runs.
-/

open Alchemy

namespace Wallet

/-! What a wallet can be asked, what it records, and why it refuses. -/

inductive Command where
  | deposit (id : String) (amount : Nat)
  | spend (id : String) (amount : Nat)
deriving DecidableEq, Repr

inductive Event where
  | deposited (amount : Nat)
  | spent (amount : Nat)
deriving DecidableEq, Repr

inductive Rejection where
  | insufficientFunds (balance requested : Nat)
  | nothingToMove
deriving DecidableEq, Repr

/-- A wallet remembers what came in and what went out. -/
structure State where
  received : Nat := 0
  spent : Nat := 0
deriving DecidableEq, Repr

def State.balance (s : State) : Nat := s.received - s.spent

/-- Decide: the events a command records, or why it is refused. -/
def decide (_ : Context Unit) (s : State) : Command → Except Rejection (List Event)
  | .deposit _ amount =>
    if amount = 0 then .error .nothingToMove else .ok [.deposited amount]
  | .spend _ amount =>
    if amount = 0 then .error .nothingToMove
    else if amount ≤ s.balance then .ok [.spent amount]
    else .error (.insufficientFunds s.balance amount)

/-- Evolve: what an event does to the state. -/
def evolve (s : State) (e : Event) (_ : Time) : State :=
  match e with
  | .deposited amount => { s with received := s.received + amount }
  | .spent amount => { s with spent := s.spent + amount }

end Wallet

open Wallet in
/-- The aggregate: the types and the two functions, tied together. -/
abbrev Wallet : Aggregate where
  name := "Wallet"
  Id := String
  State := State
  Command := Command
  Event := Event
  Rejection := Rejection
  Actor := Unit
  initial := {}
  keyOf := fun | .deposit id _ | .spend id _ => id
  decide := decide
  evolve := evolve

namespace Wallet

/-! ## A rule, proved -/

/-- A wallet never spends more than it received. -/
def NeverOverspent (s : State) : Prop := s.spent ≤ s.received

/-- No command a wallet accepts breaks the rule. -/
theorem neverOverspent_kept : Wallet.Keeps NeverOverspent := by
  intro ctx s c es h eq
  cases c <;> simp only [Wallet.decide] at eq <;> split at eq <;>
    grind [evolve, State.balance, Aggregate.apply, NeverOverspent]

/-- So it holds whatever a wallet is sent, in any order, by anyone, at any time. -/
theorem alwaysNeverOverspent (commands : List Wallet.Sent) :
    NeverOverspent (Wallet.replay {} commands) :=
  (Aggregate.Invariant.mk "NeverOverspent" NeverOverspent (by simp [NeverOverspent])
    neverOverspent_kept).always commands

/-! ## A story, run when this file compiles -/

example : Wallet.story () [
    .given [.deposited 100],
    .when (.spend "w-1" 30),
    .recorded [.spent 30],
    .when (.spend "w-1" 80),
    .rejected (.insufficientFunds 70 80),
    .when (.deposit "w-1" 0),
    .rejected .nothingToMove
  ] = true := by decide

end Wallet
