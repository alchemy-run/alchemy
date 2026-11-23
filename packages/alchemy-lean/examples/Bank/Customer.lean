import Alchemy
import Bank.Types

open Alchemy

namespace Bank

inductive CustomerState where
  | new
  | registered (name : String) (username : Username)
deriving DecidableEq, Repr

inductive CustomerEvent where
  | customerRegistered (name : String) (username : Username)
deriving DecidableEq, Repr

/--
A customer. It decides nothing alone: registering involves the username too, so
`Registration` decides it and records `customerRegistered` here.
-/
abbrev Customer : Aggregate where
  name := "Customer"
  Id := CustomerId
  State := CustomerState
  Command := Empty
  Event := CustomerEvent
  Rejection := Empty
  Actor := Actor
  initial := .new
  keyOf := nofun
  decide := nofun
  evolve
    | _, .customerRegistered name username, _ => .registered name username

inductive UsernameClaimState where
  | free
  | claimed (customerId : CustomerId)
deriving DecidableEq, Repr

inductive UsernameClaimEvent where
  | usernameClaimed (customerId : CustomerId)
deriving DecidableEq, Repr

/--
One username, and who holds it. Uniqueness spans every customer, so the rule has
an aggregate of its own, keyed by the username: every registration that asks for
a name reads this one instance.
-/
abbrev UsernameClaim : Aggregate where
  name := "UsernameClaim"
  Id := Username
  State := UsernameClaimState
  Command := Empty
  Event := UsernameClaimEvent
  Rejection := Empty
  Actor := Actor
  initial := .free
  keyOf := nofun
  decide := nofun
  evolve
    | _, .usernameClaimed customerId, _ => .claimed customerId

end Bank
