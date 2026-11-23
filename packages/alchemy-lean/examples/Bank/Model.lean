import Alchemy
import Bank.Registration
import Bank.Reads
import Bank.Processes

open Alchemy

open Bank in
/-- The bank: every aggregate, decision, view, policy, projection, stream, saga and query. -/
abbrev Bank : Model where
  name := "Bank"
  signature := BankSignature
  decisions := [Registration]
  views := [AccountSummary, CustomerDashboard, Statement, AccountActivity, TransferStatus,
    AccountTransfers, DailyOutflow]
  policies := [MainAccountProvisioning, TransferExecution, TransferApprovalDeadline, FraudReview,
    SettlementRefund]
  projections := [Ledger]
  streams := [AccountCard]
  queries := [AccountLedger]
  saga := executeTransfer

namespace Bank

/-! ## Rules about every instance -/

/-- A registration records nothing on an account or a transfer. -/
theorem registration_holds {P : Model.Rule BankAggregates}
    (customers : ∀ s, P .customer s) (claims : ∀ s, P .usernameClaim s)
    (r : Recorded BankAggregates) (ctx : Context Actor) (c : RegisterCustomer)
    (h : Model.Holds P r) : Model.Holds P (r.decide Registration ctx c) := by
  cases eq : decideRegistration ctx r.state c with
  | error _ => simpa [Recorded.decide, Registration, eq] using h
  | ok rs =>
    obtain ⟨_, _, accounts, transfers⟩ := registration_states r ctx c rs eq
    intro n id
    cases n
    · exact customers _
    · exact claims _
    · rw [accounts]; exact h .account id
    · rw [transfers]; exact h .transfer id

/--
No account in the bank withdraws more than the daily limit, and every transfer
is between two different accounts: in every world the bank can reach, whatever
callers send, in any order of delivery, with any event delivered again, whatever
the outside systems answer, and whenever scheduled commands fire.
-/
theorem everyInstanceKeepsItsRules (w : World BankSignature) (reach : Bank.Reachable w) :
    (∀ id, WithinDailyLimit (w.state .account id)) ∧
      ∀ id, BetweenTwoAccounts (w.state .transfer id) := by
  have all := Bank.always
    (P := fun
      | .account => WithinDailyLimit
      | .transfer => BetweenTwoAccounts
      | _ => fun _ => True)
    (by intro n; cases n <;> trivial)
    (by
      intro n
      cases n
      · intro _ _ c; cases c
      · intro _ _ c; cases c
      · exact withinDailyLimit.kept
      · exact betweenTwoAccounts.kept)
    (by
      intro d mem r ctx c h
      simp only [List.mem_singleton] at mem
      subst mem
      exact registration_holds (fun _ => trivial) (fun _ => trivial) r ctx c h)
    w reach
  exact ⟨fun id => all .account id, fun id => all .transfer id⟩

/-! ## Rules that relate two instances -/

/--
Whoever a username is claimed for is registered under it, and a registered
customer holds the username they registered under.
-/
def NamesMatch (r : Recorded BankAggregates) : Prop :=
  (∀ username customerId, r.state .usernameClaim username = .claimed customerId →
      ∃ name, r.state .customer customerId = .registered name username) ∧
    (∀ customerId name username, r.state .customer customerId = .registered name username →
      r.state .usernameClaim username = .claimed customerId)

theorem namesMatch_registration (r : Recorded BankAggregates) (ctx : Context Actor)
    (c : RegisterCustomer) (h : NamesMatch r) : NamesMatch (r.decide Registration ctx c) := by
  cases eq : decideRegistration ctx r.state c with
  | error _ => simpa [Recorded.decide, Registration, eq] using h
  | ok rs =>
    obtain ⟨customers, claims, _, _⟩ := registration_states r ctx c rs eq
    obtain ⟨new, free, _⟩ := registration_accepted eq
    obtain ⟨claimed, registered⟩ := h
    constructor
    · intro username customerId
      rw [claims, customers]
      grind
    · intro customerId name username
      rw [claims, customers]
      grind

/--
In every world the bank can reach, usernames and customers agree: no two
customers hold one name, and nobody is registered under a name they do not hold.
-/
theorem namesAlwaysMatch (w : World BankSignature) (reach : Bank.Reachable w) :
    NamesMatch w.toRecorded := by
  refine Bank.invariant (rule := NamesMatch) ?_ ?_ w reach
  · constructor
    · intro _ _ h; cases h
    · intro _ _ _ h; cases h
  · constructor
    · intro r now s h
      have customers : ∀ id, (r.dispatch now s).state .customer id = r.state .customer id := by
        intro id
        cases to : s.to with
        | customer => obtain ⟨to', _, c⟩ := s; subst to; cases c
        | _ => exact Recorded.dispatch_state_of_ne_name r now s .customer id (by simp [to])
      have claims :
          ∀ id, (r.dispatch now s).state .usernameClaim id = r.state .usernameClaim id := by
        intro id
        cases to : s.to with
        | usernameClaim => obtain ⟨to', _, c⟩ := s; subst to; cases c
        | _ => exact Recorded.dispatch_state_of_ne_name r now s .usernameClaim id (by simp [to])
      constructor
      · intro username customerId; rw [claims, customers]; exact h.1 username customerId
      · intro customerId name username; rw [claims, customers]; exact h.2 customerId name username
    · intro d mem r ctx c h
      simp only [List.mem_singleton] at mem
      subst mem
      exact namesMatch_registration r ctx c h

/-- No two customers hold one username. -/
theorem noTwoCustomersHoldOneName (w : World BankSignature) (reach : Bank.Reachable w)
    (one two : CustomerId) (nameOne nameTwo : String) (username : Username)
    (first : w.state .customer one = .registered nameOne username)
    (second : w.state .customer two = .registered nameTwo username) : one = two := by
  obtain ⟨_, registered⟩ := namesAlwaysMatch w reach
  have a := registered one nameOne username first
  have b := registered two nameTwo username second
  rw [a] at b
  cases b
  rfl

end Bank
