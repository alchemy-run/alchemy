import Alchemy

/-!
# A bank

How a verified domain model is built up, in five steps:

1. the domain: what an account can be asked, what it records, why it refuses;
2. behaviour: given this history, when this command arrives, then this happens;
3. invariants: facts about an account's state that no command can break;
4. consequences: what follows from the invariants, for every history;
5. the model: the same facts in every world the bank can reach, and as deployed.
-/

open Alchemy Cloud

/-! ## 1. The domain -/

namespace Account

inductive Command where
  | open (id owner : String)
  | deposit (id : String) (amount : Nat)
  | withdraw (id : String) (amount : Nat)
  | freeze (id reason : String)
  | close (id : String)
deriving DecidableEq, Repr, Lean.ToJson, Lean.FromJson

inductive Event where
  | opened (owner : String)
  | deposited (amount : Nat)
  | withdrawn (amount : Nat)
  | frozen (reason : String)
  | closed
deriving DecidableEq, Repr

inductive Rejection where
  | alreadyOpen
  | notOpen
  | nothingToMove
  | insufficientFunds (balance requested : Nat)
  | frozen (reason : String)
  | notEmpty (balance : Nat)
deriving DecidableEq, Repr

inductive Status where
  | new
  | open
  | frozen (reason : String)
  | closed
deriving DecidableEq, Repr

/-- An account keeps its balance, and separately everything that ever came in and went out. -/
structure State where
  status : Status := .new
  owner : String := ""
  balance : Nat := 0
  deposited : Nat := 0
  withdrawn : Nat := 0
deriving DecidableEq, Repr

def key : Command → String
  | .open id _ | .deposit id _ | .withdraw id _ | .freeze id _ | .close id => id

/-- Decide: the events a command records, or why it is refused. -/
def decide (s : State) : Command → Except Rejection (List Event)
  | .open _ owner =>
    if s.status = .new then .ok [.opened owner] else .error .alreadyOpen
  | .deposit _ amount =>
    if amount = 0 then .error .nothingToMove
    else match s.status with
      | .open => .ok [.deposited amount]
      | .frozen reason => .error (.frozen reason)
      | _ => .error .notOpen
  | .withdraw _ amount =>
    if amount = 0 then .error .nothingToMove
    else match s.status with
      | .open =>
        if amount ≤ s.balance then .ok [.withdrawn amount]
        else .error (.insufficientFunds s.balance amount)
      | .frozen reason => .error (.frozen reason)
      | _ => .error .notOpen
  | .freeze _ reason =>
    if s.status = .open then .ok [.frozen reason] else .error .notOpen
  | .close _ =>
    if s.status = .open then
      if s.balance = 0 then .ok [.closed] else .error (.notEmpty s.balance)
    else .error .notOpen

/-- Evolve: what an event does to the state. -/
def evolve (s : State) : Event → State
  | .opened owner => { s with status := .open, owner }
  | .deposited amount =>
    { s with balance := s.balance + amount, deposited := s.deposited + amount }
  | .withdrawn amount =>
    { s with balance := s.balance - amount, withdrawn := s.withdrawn + amount }
  | .frozen reason => { s with status := .frozen reason }
  | .closed => { s with status := .closed }

end Account

/-- What the compliance check answers about a deposit. -/
inductive Screening where
  | clear
  | flagged (reason : String)
deriving DecidableEq, Repr, Lean.ToJson, Lean.FromJson

model Bank where
  aggregate Account

  call screen (account : String) (amount : Nat) : Screening

  -- Whenever a large deposit arrives, have it screened, and freeze the account if it is flagged.
  policy Compliance on Account
    | id, .deposited amount => do
      if amount ≥ 10000 then
        match ← screen id amount with
        | .flagged reason => Account.send (.freeze id reason)
        | .clear => pure ()

  -- All the money the bank holds.
  view Holdings on Account : Int := 0
    | total, .deposited amount => total + amount
    | total, .withdrawn amount => total - amount

  -- A line for each movement of money, for the account's statement.
  projection Statement on Account : String × String × Nat
    | id, .deposited amount => [(id, "deposit", amount)]
    | id, .withdrawn amount => [(id, "withdrawal", amount)]

namespace Bank

/-! ## 2. Behaviour: given, when, then

Each holds for every owner, id and amount, not for one example.
-/

/-- Given an open account with money in it, when less than that is withdrawn, then it is paid out. -/
theorem withdrawingWhatIsThere (id owner : String) (held amount : Nat)
    (some : amount ≠ 0) (enough : amount ≤ held) :
    Account.decide (Account.after [.opened owner, .deposited held]) (.withdraw id amount)
      = .ok [.withdrawn amount] := by
  simp [Aggregate.after, Aggregate.apply, Account.decide, Account.evolve, some, enough]

/-- Given an open account, when more than it holds is withdrawn, then it is refused. -/
theorem anOverdraftIsRefused (id owner : String) (held amount : Nat) (tooMuch : held < amount) :
    Account.decide (Account.after [.opened owner, .deposited held]) (.withdraw id amount)
      = .error (.insufficientFunds held amount) := by
  have some : amount ≠ 0 := by omega
  have short : ¬amount ≤ held := by omega
  simp [Aggregate.after, Aggregate.apply, Account.decide, Account.evolve, some, short]

/-- Given a frozen account, when money is withdrawn, then it is refused, whatever it holds. -/
theorem aFrozenAccountPaysNothingOut (id owner reason : String) (held amount : Nat)
    (some : amount ≠ 0) :
    Account.decide (Account.after [.opened owner, .deposited held, .frozen reason])
        (.withdraw id amount)
      = .error (.frozen reason) := by
  simp [Aggregate.after, Aggregate.apply, Account.decide, Account.evolve, some]

/-- Given an account with money in it, when it is closed, then it is refused. -/
theorem anAccountWithMoneyStaysOpen (id owner : String) (held : Nat) (some : held ≠ 0) :
    Account.decide (Account.after [.opened owner, .deposited held]) (.close id)
      = .error (.notEmpty held) := by
  simp [Aggregate.after, Aggregate.apply, Account.decide, Account.evolve, some]

/-- Given a closed account, when money is deposited, then it is refused. -/
theorem aClosedAccountTakesNoDeposits (id owner : String) (amount : Nat) (some : amount ≠ 0) :
    Account.decide (Account.after [.opened owner, .closed]) (.deposit id amount)
      = .error .notOpen := by
  simp [Aggregate.after, Aggregate.apply, Account.decide, Account.evolve, some]

/-! ## 3. Invariants: what no command can break

A behaviour theorem is about one history. An invariant is about every state an
account can ever be in. It is proved in two parts: it holds of a new account,
and no accepted command breaks it.
-/

/-- The balance is exactly what came in less what went out. -/
def Balanced (s : Account.State) : Prop := s.balance + s.withdrawn = s.deposited

/-- A closed account holds nothing. -/
def ClosedIsEmpty (s : Account.State) : Prop := s.status = .closed → s.balance = 0

theorem balanced_kept : Account.Keeps Balanced := by
  aggregate_rule [Account.decide, Account.evolve, Balanced]

theorem closedIsEmpty_kept : Account.Keeps ClosedIsEmpty := by
  aggregate_rule [Account.decide, Account.evolve, ClosedIsEmpty]

/-- The two together, as named invariants: each holds at the start and is kept. -/
def balanced : Aggregate.Invariant Account :=
  { name := "Balanced", holds := Balanced, initially := by simp [Balanced], kept := balanced_kept }

def closedIsEmpty : Aggregate.Invariant Account :=
  { name := "ClosedIsEmpty", holds := ClosedIsEmpty, initially := by simp [ClosedIsEmpty],
    kept := closedIsEmpty_kept }

/-! ## 4. Consequences: for every history

An invariant holds after any sequence of commands, sent by anyone, in any
order. Other facts then follow from it by arithmetic.
-/

/-- An account never pays out more than was paid in: after any commands at all. -/
theorem neverPaysOutMoreThanCameIn (commands : List Account.Sent) :
    (Account.replay {} commands).withdrawn ≤ (Account.replay {} commands).deposited := by
  have := balanced.always commands
  simp only [balanced, Balanced] at this
  omega

/-- No money is lost inside an account: what it holds and what it paid out add up to what came in. -/
theorem noMoneyIsLost (commands : List Account.Sent) :
    (Account.replay {} commands).balance + (Account.replay {} commands).withdrawn
      = (Account.replay {} commands).deposited :=
  balanced.always commands

/-- After any commands, an account that is closed is empty. -/
theorem aClosedAccountIsEmpty (commands : List Account.Sent)
    (closed : (Account.replay {} commands).status = .closed) :
    (Account.replay {} commands).balance = 0 :=
  closedIsEmpty.always commands closed

/-- What one command may do: nothing but a withdrawal lowers a balance. -/
theorem onlyAWithdrawalLowersTheBalance :
    Account.Transition fun _ before command after =>
      (∀ id amount, command ≠ .withdraw id amount) → before.balance ≤ after.balance := by
  intro ctx s c es eq
  cases c <;> simp only [Account.decide] at eq <;> (repeat' split at eq) <;>
    grind [Aggregate.apply, Account.evolve]

/-! ## 5. The model: every world the bank can reach

The bank is more than one account: there are many, a policy reacts to
deposits, and an outside system answers whatever it likes. The invariants hold
all the same, of every account, and of the bank as it is deployed.
-/

/--
In every world the bank can reach, every account is balanced: whatever callers
send, whatever compliance answers, in any order of delivery, with any event
delivered twice.
-/
theorem everyAccountBalanced (w : Alchemy.World Signature) (reach : Bank.Reachable w)
    (id : String) : Balanced (w.state .Account id) :=
  Account.always (by simp [Balanced]) balanced_kept w reach id

/-- And of the bank as deployed: whatever its journal holds. -/
theorem deployedAccountsBalanced (journal : List Journal.Line) (id : String) :
    Balanced ((served.replay journal).state .Account id) :=
  Account.deployed (by simp [Balanced]) balanced_kept journal id

/-- So the deployed bank never pays out of an account more than was paid into it. -/
theorem theBankNeverPaysOutMoreThanCameIn (journal : List Journal.Line) (id : String) :
    ((served.replay journal).state .Account id).withdrawn
      ≤ ((served.replay journal).state .Account id).deposited := by
  have := deployedAccountsBalanced journal id
  simp only [Balanced] at this
  omega

/-- And a closed account in the deployed bank is empty. -/
theorem deployedClosedAccountsAreEmpty (journal : List Journal.Line) (id : String)
    (closed : ((served.replay journal).state .Account id).status = .closed) :
    ((served.replay journal).state .Account id).balance = 0 :=
  (Account.deployed (by simp [ClosedIsEmpty]) closedIsEmpty_kept journal id : ClosedIsEmpty _) closed

/-! What is read from the bank. These came with the model. -/

example (log : List (Emitted Aggregates)) :
    Holdings.stateAt log () = log.foldl Holdings.step 0 := Holdings.exact log

example (log : List (Emitted Aggregates)) :
    Statement.table log = log.flatMap Statement.rows := Statement.exact log

/-! ## A story: one run, as a test -/

example : Bank.passes [
    .when ⟨.Account, (), .open "a-1" "Sam"⟩,
    .when ⟨.Account, (), .deposit "a-1" 500⟩,
    .when ⟨.Account, (), .withdraw "a-1" 200⟩,
    .view Holdings () 300,
    .when ⟨.Account, (), .deposit "a-1" 25000⟩,
    .call (.screen "a-1" 25000),
    .answer (.screen "a-1" 25000) (.flagged "source of funds"),
    .recorded .Account "a-1" [.opened "Sam", .deposited 500, .withdrawn 200, .deposited 25000,
      .frozen "source of funds"],
    .when ⟨.Account, (), .withdraw "a-1" 100⟩,
    .rejected .Account (.frozen "source of funds")
  ] = true := by decide

end Bank
