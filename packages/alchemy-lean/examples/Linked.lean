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

/-! ## Three models: a network

The bank's wires are sent by a third model, the wire desk, with a rule of its
own. A `Network` joins any number of models. Each model's theorems hold of all
of them together, and a run goes through all three.
-/

aggregate Transfer where
  command
    | send (payout account : String) (amount : Nat)
        records sent
        rejects alreadySent, tooLarge

  event
    | sent (account : String) (amount : Nat)

  rejection
    | alreadySent
    | tooLarge

  state
    sent : Nat := 0
    count : Nat := 0

  decide
    | s, .send _ account amount =>
      if s.count ≠ 0 then .error .alreadySent
      else if amount > 100000 then .error .tooLarge
      else .ok [.sent account amount]

  evolve
    | s, .sent _ amount => { sent := s.sent + amount, count := s.count + 1 }

model Wires where
  aggregate Transfer

namespace Wires

/-- A wire is sent at most once, and never for more than the desk's limit. -/
def SentOnce (s : Transfer.State) : Prop :=
  (s.count = 0 → s.sent = 0) ∧ s.count ≤ 1 ∧ s.sent ≤ 100000

theorem sentOnce_kept : Transfer.Keeps SentOnce := by aggregate_rule

theorem everyWireSentOnce (w : Alchemy.World Signature) (reach : Wires.Reachable w)
    (payout : String) : SentOnce (w.state .Transfer payout) :=
  Transfer.always (by simp [SentOnce]) sentOnce_kept w reach payout

/-- One step of the wire desk, when nothing is part-way through: an event is taken off the inbox. -/
theorem step_idle {w w' : Alchemy.World Signature} (idle : w.fibers = [])
    (step : Wires.stepOnce w = some w') : w'.fibers = [] ∧ w'.inbox.length < w.inbox.length := by
  unfold Model.stepOnce at step
  split at step
  · next event rest inbox =>
    cases step
    simp [Model.react, idle, inbox]
  · simp [idle, Model.tryFibers] at step

/--
The wire desk comes to rest. From any world with nothing part-way through, it
stops within as many steps as there are events to deliver: a measure that every
step lowers.
-/
theorem comesToRest (w : Alchemy.World Signature) (idle : w.fibers = []) :
    Wires.AtRest (Wires.settle w.inbox.length w) :=
  Wires.comesToRestWithin (fun w => w.fibers = []) (fun w => w.inbox.length)
    (fun _ _ idle step => (step_idle idle step).1) (fun _ _ idle step => (step_idle idle step).2)
    _ w idle (Nat.le_refl _)

/-- So eventually the desk is at rest with every wire sent at most once. -/
theorem eventuallyEveryWireSentOnce (w : Alchemy.World Signature) (reach : Wires.Reachable w)
    (idle : w.fibers = []) (payout : String) :
    Wires.Eventually w fun rested => SentOnce (rested.state .Transfer payout) :=
  ⟨w.inbox.length, comesToRest w idle,
    everyWireSentOnce _ (Wires.settle_reachable _ w reach) payout⟩

end Wires

/-- The three models. -/
inductive Part where
  | bank
  | compliance
  | wires
deriving DecidableEq, Repr

abbrev part : Part → Model
  | .bank => Bank
  | .compliance => Compliance
  | .wires => Wires

/-- The bank's screening goes to compliance, and its wires to the wire desk. -/
def institution : Network Part part where
  ask
    | .bank, .screen account amount =>
      some ⟨.compliance, ⟨.Watch, .system, .assess account amount⟩⟩
    | .bank, .wire payout account amount =>
      some ⟨.wires, ⟨.Transfer, (), .send payout account amount⟩⟩
    | .compliance, call => nomatch call
    | .wires, call => nomatch call
  reply
    | .bank, .screen .., .compliance, ⟨.Watch, _, _⟩, .ok [.flagged _] =>
      .flagged "over the reporting threshold"
    | .bank, .screen .., _, _, _ => .clear
    | .bank, .wire .., .wires, ⟨.Transfer, _, _⟩, .ok _ => .sent
    | .bank, .wire .., _, _, _ => .bounced
    | .compliance, call, _, _, _ => nomatch call
    | .wires, call, _, _, _ => nomatch call
  offered := by intro i c j s _; cases j <;> trivial
  parts := [.bank, .compliance, .wires]

/--
In every world the three can reach together: every account is balanced, no
transfer has created money, compliance never objected more often than it
looked, and every wire was sent at most once. Each was proved of one model
alone; none is proved again.
-/
theorem allThreeAreSound (w : institution.Worlds) (reach : institution.Reachable w)
    (account payout : String) :
    Bank.Balanced ((w .bank).state .Account account) ∧
      Bank.Conserved (w .bank).toRecorded ∧
      Compliance.FlagsAreAssessments ((w .compliance).state .Watch account) ∧
      Wires.SentOnce ((w .wires).state .Transfer payout) :=
  ⟨Bank.everyAccountBalanced _ (institution.reachable_each reach .bank) account,
    Bank.noTransferCreatesMoney _ (institution.reachable_each reach .bank),
    Compliance.everyWatchIsSound _ (institution.reachable_each reach .compliance) account,
    Wires.everyWireSentOnce _ (institution.reachable_each reach .wires) payout⟩

/-- A payout through all three: the bank takes the money out, and the wire desk sends it. -/
def aPayout : institution.Worlds := institution.run [
  ⟨.bank, .send ⟨.Account, (), .open "a-1" "Sam"⟩⟩,
  ⟨.bank, .send ⟨.Account, (), .deposit "a-1" 500⟩⟩,
  ⟨.bank, .send ⟨.Account, (), .requestPayout "a-1" "p-1" 200⟩⟩ ]

example : ((aPayout .bank).state .Account "a-1").balance = 300 ∧
    (aPayout .bank).sagas (.Payout, "p-1") = .completed ∧
    (aPayout .wires).state .Transfer "p-1" = { sent := 200, count := 1 } := by
  native_decide

/--
A payout over the desk's limit: the wire desk refuses, and the bank puts the
money back. The refund is itself a large deposit, so compliance screens it, and
flags it: the account ends up frozen. Nobody wrote that down; it is what the
three models do together.
-/
def aPayoutTooLarge : institution.Worlds := institution.run [
  ⟨.bank, .send ⟨.Account, (), .open "a-1" "Sam"⟩⟩,
  ⟨.bank, .send ⟨.Account, (), .deposit "a-1" 40000⟩⟩,
  ⟨.bank, .send ⟨.Account, (), .deposit "a-1" 40000⟩⟩,
  ⟨.bank, .send ⟨.Account, (), .deposit "a-1" 40000⟩⟩,
  ⟨.bank, .send ⟨.Account, (), .requestPayout "a-1" "p-1" 110000⟩⟩ ]

example : ((aPayoutTooLarge .bank).state .Account "a-1").balance = 120000 ∧
    ((aPayoutTooLarge .bank).state .Account "a-1").status = .frozen "over the reporting threshold" ∧
    (aPayoutTooLarge .bank).sagas (.Payout, "p-1") = .failed (.Payout .bounced) ∧
    (aPayoutTooLarge .compliance).state .Watch "a-1" = { assessed := 4, flagged := 1 } ∧
    (aPayoutTooLarge .wires).state .Transfer "p-1" = {} := by
  native_decide

/--
The run above is one the network can reach, so everything proved of every
reachable world holds of it, in whatever order its calls were answered.
-/
theorem thePayoutRunIsSound :
    Bank.Balanced ((aPayout .bank).state .Account "a-1") ∧
      Bank.Conserved (aPayout .bank).toRecorded ∧
      Compliance.FlagsAreAssessments ((aPayout .compliance).state .Watch "a-1") ∧
      Wires.SentOnce ((aPayout .wires).state .Transfer "p-1") :=
  allThreeAreSound _
    (institution.run_reachable [
        ⟨.bank, ⟨.Account, (), .open "a-1" "Sam"⟩⟩,
        ⟨.bank, ⟨.Account, (), .deposit "a-1" 500⟩⟩,
        ⟨.bank, ⟨.Account, (), .requestPayout "a-1" "p-1" 200⟩⟩]
      (by intro command _; obtain ⟨part, _⟩ := command; cases part <;> trivial))
    "a-1" "p-1"
