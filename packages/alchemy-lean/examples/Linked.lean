import Accounts

/-!
# Two models, linked

The bank calls a compliance check. Here that check is another domain model,
with rules of its own, and a `Link` says how the bank's call becomes a command
for it. Everything proved of each model alone holds of the two together.
-/

open Alchemy Cloud

/-! ## The compliance model -/

/-- Who sends compliance a command: the bank's systems, or a compliance officer. -/
inductive Watch.Who where
  | system
  | officer (name : String)
deriving DecidableEq, Repr, Inhabited

derive_tokens Watch.Who

aggregate Watch where
  actor : Who

  command
    | assess (account : String) (amount : Nat)
        records cleared, flagged
        rejects nothingToAssess
    | dismiss (account : String)
        records dismissed
        rejects notAnOfficer, nothingFlagged

  event
    | cleared (amount : Nat)
    | flagged (amount : Nat)
    | dismissed (by_ : String)

  rejection
    | nothingToAssess
    | notAnOfficer
    | nothingFlagged

  -- what compliance knows about one account: how often it looked, and how often it objected
  state
    assessed : Nat := 0
    flagged : Nat := 0

  decide
    | _, _, .assess _ amount =>
      if amount = 0 then .error .nothingToAssess
      else if amount ≥ 50000 then .ok [.flagged amount]
      else .ok [.cleared amount]
    | .officer name, s, .dismiss _ =>
      if s.flagged = 0 then .error .nothingFlagged else .ok [.dismissed name]
    | .system, _, .dismiss _ => .error .notAnOfficer

  evolve
    | s, .cleared _ => { s with assessed := s.assessed + 1 }
    | s, .flagged _ => { assessed := s.assessed + 1, flagged := s.flagged + 1 }
    | s, .dismissed _ => { s with flagged := s.flagged - 1 }

model Compliance where
  aggregate Watch

namespace Compliance

/-- Compliance never objects more often than it looked. -/
def FlagsAreAssessments (s : Watch.State) : Prop := s.flagged ≤ s.assessed

theorem flagsAreAssessments_kept : Watch.Keeps FlagsAreAssessments := by
  aggregate_rule

/-- Only an officer dismisses a flag: whatever the account holds, the bank's systems are refused. -/
theorem onlyAnOfficerDismisses (account : String) (s : Watch.State) :
    Watch.decide .system s (.dismiss account) = .error .notAnOfficer := by
  simp [Watch.decide]

theorem everyWatchIsSound (w : Alchemy.World Signature) (reach : Compliance.Reachable w)
    (account : String) : FlagsAreAssessments (w.state .Watch account) :=
  Watch.always (by simp [FlagsAreAssessments]) flagsAreAssessments_kept w reach account

end Compliance

/-! ## The link -/

/-- The bank's screening call is answered by the compliance model. -/
def screening : Link Bank Compliance where
  ask
    | .screen account amount => some ⟨.Watch, .system, .assess account amount⟩
    | .wire .. => none
  reply
    | .screen .., ⟨.Watch, _, _⟩, .ok [.flagged _] => .flagged "over the reporting threshold"
    | .screen .., _, _ => .clear
    | .wire .., _, _ => .bounced

/-! ## What holds of the two together -/

/--
In every world the bank and compliance can reach together: every account is
balanced, no transfer has created money, and compliance never objected more
often than it looked. Each was proved of one model alone; none is proved again.
-/
theorem bothAreSound (w : screening.Worlds) (reach : screening.Reachable w) (account : String) :
    Bank.Balanced (w.1.state .Account account) ∧
      Bank.Conserved w.1.toRecorded ∧
      Compliance.FlagsAreAssessments (w.2.state .Watch account) :=
  ⟨Bank.everyAccountBalanced _ (screening.reachable_left reach) account,
    Bank.noTransferCreatesMoney _ (screening.reachable_left reach),
    Compliance.everyWatchIsSound _ (screening.reachable_right reach) account⟩

/-! ## Behaviour across both models

These are about the two models together: what one does because of what the
other answered. Each holds for every account and amount.
-/

/--
Given an open account, when a deposit over the reporting threshold arrives,
then compliance flags it and the bank freezes the account.
-/
theorem aReportableDepositFreezesTheAccount (id owner : String) (amount : Nat)
    (reportable : amount ≥ 50000) :
    let both := screening.run [
      .send ⟨.Account, (), .open id owner⟩,
      .send ⟨.Account, (), .deposit id amount⟩]
    (both.1.state .Account id).status = .frozen "over the reporting threshold" ∧
      both.2.state .Watch id = { assessed := 1, flagged := 1 } := by
  behaviour [screening]

/--
Given an open account, when a large deposit under the reporting threshold
arrives, then compliance looks at it, has no objection, and the account stays open.
-/
theorem aLargeDepositIsLookedAtAndLeftAlone (id owner : String) (amount : Nat)
    (large : amount ≥ 10000) (unremarkable : amount < 50000) :
    let both := screening.run [
      .send ⟨.Account, (), .open id owner⟩,
      .send ⟨.Account, (), .deposit id amount⟩]
    (both.1.state .Account id).status = .open ∧
      both.2.state .Watch id = { assessed := 1, flagged := 0 } := by
  behaviour [screening]

/--
Given an open account, when a small deposit arrives, then compliance is never
asked at all.
-/
theorem aSmallDepositIsNotScreened (id owner : String) (amount : Nat)
    (some : amount ≠ 0) (small : amount < 10000) :
    let both := screening.run [
      .send ⟨.Account, (), .open id owner⟩,
      .send ⟨.Account, (), .deposit id amount⟩]
    (both.1.state .Account id).status = .open ∧ both.2.state .Watch id = {} := by
  behaviour [screening]

/-! ## A run of the two together -/

/-- A large deposit: compliance flags it, and the bank freezes the account. -/
def aLargeDeposit : screening.Worlds := screening.run [
  .send ⟨.Account, (), .open "a-1" "Sam"⟩,
  .send ⟨.Account, (), .deposit "a-1" 60000⟩ ]

example : (aLargeDeposit.1.state .Account "a-1").status = .frozen "over the reporting threshold" ∧
    aLargeDeposit.2.state .Watch "a-1" = { assessed := 1, flagged := 1 } := by
  native_decide

/-- A deposit compliance has no objection to: it looks, and the account stays open. -/
def anOrdinaryLargeDeposit : screening.Worlds := screening.run [
  .send ⟨.Account, (), .open "a-1" "Sam"⟩,
  .send ⟨.Account, (), .deposit "a-1" 20000⟩ ]

example : (anOrdinaryLargeDeposit.1.state .Account "a-1").status = .open ∧
    anOrdinaryLargeDeposit.2.state .Watch "a-1" = { assessed := 1, flagged := 0 } := by
  native_decide
