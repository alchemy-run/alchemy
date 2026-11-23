import Alchemy
import Bank.Shape

open Alchemy

namespace Bank

/-- Sign up as a customer under a unique username. -/
structure RegisterCustomer where
  customerId : CustomerId
  name : String
  username : Username
deriving DecidableEq, Repr

inductive RegistrationRejection where
  | alreadyRegistered
  /-- A customer may only register themselves. -/
  | notTheCustomer
  /-- Someone else holds this username. -/
  | usernameTaken
deriving DecidableEq, Repr

/-- Whether this actor may register this customer. -/
def mayRegister : Actor → CustomerId → Bool
  | .customer actor, customerId => actor = customerId
  | _, _ => true

def decideRegistration (ctx : Context Actor) (state : States BankAggregates)
    (c : RegisterCustomer) : Except RegistrationRejection (List (Record BankAggregates)) :=
  if mayRegister ctx.actor c.customerId then
    match state .customer c.customerId with
    | .registered .. => .error .alreadyRegistered
    | .new =>
      match state .usernameClaim c.username with
      | .claimed _ => .error .usernameTaken
      | .free =>
        .ok [
          ⟨.customer, c.customerId, .customerRegistered c.name c.username⟩,
          ⟨.usernameClaim, c.username, .usernameClaimed c.customerId⟩ ]
  else .error .notTheCustomer

/--
Register a customer and claim their username together. Both are recorded, or
neither is: a taken username rejects the registration, and two customers who ask
for one name can't both get it.
-/
def Registration : Decision BankAggregates where
  name := "Registration"
  Command := RegisterCustomer
  Rejection := RegistrationRejection
  Actor := Actor
  decide := decideRegistration

/-- What a registration that is accepted found, and what it records. -/
theorem registration_accepted {ctx : Context Actor} {state : States BankAggregates}
    {c : RegisterCustomer} {rs : List (Record BankAggregates)}
    (h : decideRegistration ctx state c = .ok rs) :
    state .customer c.customerId = .new ∧ state .usernameClaim c.username = .free ∧
      rs = [
        ⟨.customer, c.customerId, .customerRegistered c.name c.username⟩,
        ⟨.usernameClaim, c.username, .usernameClaimed c.customerId⟩ ] := by
  unfold decideRegistration at h
  split at h
  · split at h
    · simp at h
    · next new =>
      split at h
      · simp at h
      · next free => simp at h; exact ⟨new, free, h.symm⟩
  · simp at h

/-- Every state after a registration: the customer's, the username's, and the rest untouched. -/
theorem registration_states (r : Recorded BankAggregates) (ctx : Context Actor)
    (c : RegisterCustomer) (rs : List (Record BankAggregates))
    (h : decideRegistration ctx r.state c = .ok rs) :
    let after := r.decide Registration ctx c
    (∀ id, after.state .customer id =
        if id = c.customerId then .registered c.name c.username else r.state .customer id) ∧
    (∀ id, after.state .usernameClaim id =
        if id = c.username then .claimed c.customerId else r.state .usernameClaim id) ∧
    (∀ id, after.state .account id = r.state .account id) ∧
    (∀ id, after.state .transfer id = r.state .transfer id) := by
  obtain ⟨_, _, records⟩ := registration_accepted h
  subst records
  simp only [Recorded.decide, Registration, h, Recorded.records, List.foldl]
  refine ⟨?_, ?_, ?_, ?_⟩ <;> intro id <;>
    simp [Recorded.record, States.set, Aggregate.apply] <;> grind

/-! ## Rules about the decision -/

/-- The username goes to the customer who registered under it. -/
theorem theNameGoesToWhoRegistered (r : Recorded BankAggregates) (ctx : Context Actor)
    (c : RegisterCustomer) (rs : List (Record BankAggregates))
    (h : decideRegistration ctx r.state c = .ok rs) :
    (r.decide Registration ctx c).state .customer c.customerId = .registered c.name c.username ∧
      (r.decide Registration ctx c).state .usernameClaim c.username = .claimed c.customerId := by
  obtain ⟨customers, claims, _, _⟩ := registration_states r ctx c rs h
  simp [customers, claims]

/-- A name is only given while nobody holds it. -/
theorem onlyAFreeNameIsClaimed (r : Recorded BankAggregates) (ctx : Context Actor)
    (c : RegisterCustomer) (rs : List (Record BankAggregates))
    (h : decideRegistration ctx r.state c = .ok rs) :
    r.state .usernameClaim c.username = .free :=
  (registration_accepted h).2.1

/-- Once somebody holds a name, no registration gives it to anybody else. -/
theorem aClaimedNameStaysWithItsHolder (r : Recorded BankAggregates) (ctx : Context Actor)
    (c : RegisterCustomer) (username : Username) (holder : CustomerId)
    (held : r.state .usernameClaim username = .claimed holder) :
    (r.decide Registration ctx c).state .usernameClaim username = .claimed holder := by
  cases h : decideRegistration ctx r.state c with
  | error _ => simpa [Recorded.decide, Registration, h] using held
  | ok rs =>
    obtain ⟨_, claims, _, _⟩ := registration_states r ctx c rs h
    have free := (registration_accepted h).2.1
    rw [claims]
    split
    · next same => subst same; rw [free] at held; cases held
    · exact held

end Bank
