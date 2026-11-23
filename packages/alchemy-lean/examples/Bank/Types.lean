import Alchemy

namespace Bank

abbrev AccountId := String
abbrev CustomerId := String
abbrev TransferId := String
abbrev Username := String
/-- Money, in cents. It cannot be negative, so no balance is ever overdrawn. -/
abbrev Cents := Nat

/-- Who is acting. -/
inductive Actor where
  | customer (customerId : CustomerId)
  | agent (agentId : String)
  | system (name : String)
deriving DecidableEq, Repr

/-- The day a moment falls on. Time is counted in seconds. -/
def dayOf (time : Alchemy.Time) : Nat := time / 86400

/-- The account opened for a customer when they register. -/
def mainAccountId (customerId : CustomerId) : AccountId := customerId ++ "-main"

end Bank
