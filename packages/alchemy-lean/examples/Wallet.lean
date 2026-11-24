import Alchemy

/-!
# A wallet

The smallest whole example: one aggregate, one rule proved about it, and one
story the compiler runs.
-/

open Alchemy

/-- A wallet remembers what came in and what went out. -/
aggregate Wallet where
  command
    | deposit (id : String) (amount : Nat)
        records deposited
        rejects nothingToMove
    | spend (id : String) (amount : Nat)
        records spent
        rejects nothingToMove, insufficientFunds

  event
    | deposited (amount : Nat)
    | spent (amount : Nat)

  rejection
    | insufficientFunds (balance requested : Nat)
    | nothingToMove

  state
    received : Nat := 0
    spent : Nat := 0

  decide
    | _, .deposit _ amount =>
      if amount = 0 then .error .nothingToMove else .ok [.deposited amount]
    | s, .spend _ amount =>
      if amount = 0 then .error .nothingToMove
      else if amount ≤ s.received - s.spent then .ok [.spent amount]
      else .error (.insufficientFunds (s.received - s.spent) amount)

  evolve
    | s, .deposited amount => { s with received := s.received + amount }
    | s, .spent amount => { s with spent := s.spent + amount }

namespace Wallet

/-! ## A rule, proved -/

/-- A wallet never spends more than it received. -/
def NeverOverspent (s : State) : Prop := s.spent ≤ s.received

/-- No command a wallet accepts breaks the rule. -/
theorem neverOverspent_kept : Wallet.Keeps NeverOverspent := by aggregate_rule

/-- So it holds whatever a wallet is sent, in any order, by anyone, at any time. -/
theorem alwaysNeverOverspent (commands : List Wallet.Sent) :
    NeverOverspent (Wallet.replay {} commands) :=
  (Aggregate.Invariant.mk "NeverOverspent" NeverOverspent (by simp [NeverOverspent])
    neverOverspent_kept).always commands

/-! ## Behaviour, for every amount -/

/-- Given a wallet with money in it, when more than that is spent, then it is refused. -/
theorem overspendingIsRefused (id : String) (held amount : Nat) (tooMuch : held < amount) :
    Wallet.decide (Wallet.after [.deposited held]) (.spend id amount)
      = .error (.insufficientFunds held amount) := by
  have some : amount ≠ 0 := by omega
  have short : ¬amount ≤ held := by omega
  simp [Aggregate.after, Aggregate.apply, Wallet.decide, Wallet.evolve, some, short]

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
