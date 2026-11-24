import Alchemy

/-!
# A bank

How a verified domain model is built up, in six steps:

1. the domain: what an account can be asked, what it records, why it refuses;
2. behaviour: given this history, when this command arrives, then this happens;
3. invariants: facts about an account's state that no command can break;
4. consequences: what follows from the invariants, for every history;
5. across accounts: a transfer, decided over two accounts at once, creates no money;
6. the model: the same facts in every world the bank can reach, and as deployed.
-/

open Alchemy Cloud

/-! ## 1. The domain -/

inductive Account.Status where
  | new
  | open
  | frozen (reason : String)
  | closed
deriving DecidableEq, Repr

aggregate Account where
  command
    | open (id owner : String)
        records opened
        rejects alreadyOpen
    | deposit (id : String) (amount : Nat)
        records deposited
        rejects nothingToMove, frozen, notOpen
    | withdraw (id : String) (amount : Nat)
        records withdrawn
        rejects nothingToMove, insufficientFunds, frozen, notOpen
    | freeze (id reason : String)
        records frozen
        rejects notOpen
    | close (id : String)
        records closed
        rejects notEmpty, notOpen
    | requestPayout (id payout : String) (amount : Nat)
        records payoutRequested
        rejects notOpen

  event
    | opened (owner : String)
    | deposited (amount : Nat)
    | withdrawn (amount : Nat)
    | transferredOut (amount : Nat)
    | transferredIn (amount : Nat)
    | frozen (reason : String)
    | closed
    | payoutRequested (payout : String) (amount : Nat)

  rejection
    | alreadyOpen
    | notOpen
    | nothingToMove
    | insufficientFunds (balance requested : Nat)
    | frozen (reason : String)
    | notEmpty (balance : Nat)

  -- the balance, and separately everything that ever came in and went out
  state
    status : Status := .new
    owner : String := ""
    balance : Nat := 0
    deposited : Nat := 0
    withdrawn : Nat := 0

  decide
    | s, .open _ owner =>
      if s.status = .new then .ok [.opened owner] else .error .alreadyOpen
    | s, .deposit _ amount =>
      if amount = 0 then .error .nothingToMove
      else match s.status with
        | .open => .ok [.deposited amount]
        | .frozen reason => .error (.frozen reason)
        | _ => .error .notOpen
    | s, .withdraw _ amount =>
      if amount = 0 then .error .nothingToMove
      else match s.status with
        | .open =>
          if amount ≤ s.balance then .ok [.withdrawn amount]
          else .error (.insufficientFunds s.balance amount)
        | .frozen reason => .error (.frozen reason)
        | _ => .error .notOpen
    | s, .freeze _ reason =>
      if s.status = .open then .ok [.frozen reason] else .error .notOpen
    | s, .close _ =>
      if s.status = .open then
        if s.balance = 0 then .ok [.closed] else .error (.notEmpty s.balance)
      else .error .notOpen
    | s, .requestPayout _ payout amount =>
      if s.status = .open then .ok [.payoutRequested payout amount] else .error .notOpen

  evolve
    | s, .opened owner => { s with status := .open, owner }
    | s, .deposited amount =>
      { s with balance := s.balance + amount, deposited := s.deposited + amount }
    | s, .withdrawn amount =>
      { s with balance := s.balance - amount, withdrawn := s.withdrawn + amount }
    | s, .transferredOut amount =>
      { s with balance := s.balance - amount, withdrawn := s.withdrawn + amount }
    | s, .transferredIn amount =>
      { s with balance := s.balance + amount, deposited := s.deposited + amount }
    | s, .frozen reason => { s with status := .frozen reason }
    | s, .closed => { s with status := .closed }
    | s, .payoutRequested .. => s

  -- an accepted command answers the balance it left
  reply : Nat
    | s, _ => s.balance

/-- What the compliance check answers about a deposit. -/
inductive Screening where
  | clear
  | flagged (reason : String)
deriving DecidableEq, Repr, Lean.ToJson, Lean.FromJson

/-- Move money from one account to another. -/
structure TransferRequest where
  source : String
  destination : String
  amount : Nat
deriving DecidableEq, Repr, Lean.ToJson, Lean.FromJson

inductive TransferRefused where
  | sameAccount
  | nothingToMove
  | sourceNotOpen
  | destinationNotOpen
  | insufficientFunds (balance requested : Nat)
deriving DecidableEq, Repr

/-- What a payout is started with. -/
structure PayoutRequest where
  account : String
  amount : Nat
deriving DecidableEq, Repr

/-- What the wire service answers. -/
inductive WireResult where
  | sent
  | bounced
deriving DecidableEq, Repr, Lean.ToJson, Lean.FromJson

inductive PayoutFailed where
  | refused
  | bounced
deriving DecidableEq, Repr

model Bank where
  aggregate Account

  -- A transfer is decided across two accounts at once: both record it, or neither does.
  decision Transfer (TransferRequest) : TransferRefused
    | accounts, ⟨source, destination, amount⟩ =>
      if source = destination then .error .sameAccount
      else if amount = 0 then .error .nothingToMove
      else if (Account.of accounts source).status ≠ .open then .error .sourceNotOpen
      else if (Account.of accounts destination).status ≠ .open then .error .destinationNotOpen
      else if (Account.of accounts source).balance < amount then
        .error (.insufficientFunds (Account.of accounts source).balance amount)
      else .ok [
        Account.record source (.transferredOut amount),
        Account.record destination (.transferredIn amount)]

  call screen (account : String) (amount : Nat) : Screening
  call wire (payout account : String) (amount : Nat) : WireResult

  -- A payout takes the money out, then wires it. If the wire bounces, the money goes back.
  saga Payout (PayoutRequest) (Unit) : PayoutFailed
    | payout, ⟨account, amount⟩ => do
      Account.must (.withdraw account amount) fun _ => .refused
      Account.undoWith (.deposit account amount)
      match ← wire payout account amount with
      | .sent => pure ()
      | .bounced => failWith .bounced

  policy Payouts on Account
    | id, .payoutRequested payout amount => Payout.start payout ⟨id, amount⟩

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
  -- Each account's balance, as a reader sees it.
  view Balances on Account by id : Int := 0
    | balance, .deposited amount => balance + amount
    | balance, .withdrawn amount => balance - amount
    | balance, .transferredIn amount => balance + amount
    | balance, .transferredOut amount => balance - amount

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

/-- Given an open account, when money is withdrawn, then the caller is told the balance that is left. -/
theorem aWithdrawalAnswersWhatIsLeft (id owner : String) (held amount : Nat) :
    Account.reply (Account.after [.opened owner, .deposited held, .withdrawn amount])
        (.withdraw id amount)
      = held - amount := by
  simp [Aggregate.after, Aggregate.apply, Account.reply, Account.evolve]

/-! ## General properties of the commands -/

/-- Freezing and closing are idempotent: doing either twice is doing it once. -/
theorem freezingIsIdempotent (id reason : String) : Account.IdempotentAt (.freeze id reason) := by
  command_law

theorem closingIsIdempotent (id : String) : Account.IdempotentAt (.close id) := by
  command_law

/-- A deposit is not: sent twice, the money arrives twice. A caller must not retry it blindly. -/
theorem aDepositIsNotIdempotent (id : String) : ¬Account.IdempotentAt (.deposit id 1) := by
  intro idempotent
  have := idempotent ⟨(), 0⟩ { status := .open }
  simp [Aggregate.step, Aggregate.apply, Account.decide, Account.evolve] at this

/-- Two deposits commute: the order they arrive in does not matter. -/
theorem depositsCommute (id other : String) (amount more : Nat) :
    Account.Commute (.deposit id amount) (.deposit other more) := by
  command_law

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
  aggregate_rule

theorem closedIsEmpty_kept : Account.Keeps ClosedIsEmpty := by
  aggregate_rule

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

/-! ## 5. Across accounts: a transfer

A transfer touches two accounts, so no one account's rule can speak for it. It
is a decision: it reads both accounts and records on both, or on neither. Two
things are proved of it. Each account it touches still keeps its invariants.
And across all accounts, it moves money without making any.
-/

/-- What the transfer records when it accepts, and what was true for it to accept. -/
theorem transfer_accepted {accounts : States Aggregates} {request : TransferRequest}
    {records : List (Record Aggregates)} (accepted : Transfer.decide accounts request = .ok records) :
    request.source ≠ request.destination ∧
      (accounts .Account request.source).status = .open ∧
      (accounts .Account request.destination).status = .open ∧
      request.amount ≤ (accounts .Account request.source).balance ∧
      records = [⟨.Account, request.source, .transferredOut request.amount⟩,
        ⟨.Account, request.destination, .transferredIn request.amount⟩] := by
  obtain ⟨source, destination, amount⟩ := request
  simp only [Transfer.decide, Account.of, Account.record] at accepted
  by_cases same : source = destination
  · simp [same] at accepted
  by_cases none : amount = 0
  · simp [same, none] at accepted
  by_cases sourceOpen : (accounts .Account source).status = .open
  · by_cases destinationOpen : (accounts .Account destination).status = .open
    · by_cases short : (accounts .Account source).balance < amount
      · simp [same, none, sourceOpen, destinationOpen, short] at accepted
      · simp [same, none, sourceOpen, destinationOpen, short] at accepted
        exact ⟨same, sourceOpen, destinationOpen, Nat.le_of_not_lt short, accepted.symm⟩
    · simp [same, none, sourceOpen, destinationOpen] at accepted
  · simp [same, none, sourceOpen] at accepted

/-- A rule about one account survives every decision of the bank. -/
abbrev SurvivesDecisions (P : Account.State → Prop) : Prop :=
  ∀ d ∈ Bank.decisions, ∀ (r : Recorded Aggregates) (ctx : Context d.Actor) c,
    (∀ id, P (r.state .Account id)) → ∀ id, P ((r.decide d ctx c).state .Account id)

/--
A rule about one account survives a transfer, if it survives money leaving an
open account that holds enough, and money arriving in an open account.
-/
theorem transfer_keeps {P : Account.State → Prop}
    (leaving : ∀ s amount, P s → s.status = .open → amount ≤ s.balance →
      P (Account.evolve s (.transferredOut amount)))
    (arriving : ∀ s amount, P s → s.status = .open → P (Account.evolve s (.transferredIn amount))) :
    SurvivesDecisions P := by
  intro d mem
  simp only [List.mem_singleton] at mem
  subst mem
  intro r ctx request holds id
  simp only [Recorded.decide]
  cases accepted : Transfer.decide r.state request with
  | error _ => exact holds id
  | ok records =>
    obtain ⟨differ, sourceOpen, destinationOpen, enough, rfl⟩ := transfer_accepted accepted
    simp only [Recorded.records, List.foldl, Recorded.record_state]
    by_cases toHere : request.destination = id
    · have notSource : ¬request.source = request.destination := differ
      simp only [toHere, ite_true]
      subst toHere
      simp only [notSource, ite_false]
      exact arriving _ _ (holds _) destinationOpen
    · simp only [toHere, ite_false]
      by_cases fromHere : request.source = id
      · subst fromHere
        simp only [ite_true]
        exact leaving _ _ (holds _) sourceOpen enough
      · simp only [fromHere, ite_false]
        exact holds id

/-- Money moved out by transfers, and money moved in, as each event records it. -/
def movedOut : Account.Event → Nat
  | .transferredOut amount => amount
  | _ => 0

def movedIn : Account.Event → Nat
  | .transferredIn amount => amount
  | _ => 0

/-- Across every account: all the money transfers took out equals all the money they put in. -/
def Conserved (r : Recorded Aggregates) : Prop :=
  ((r.eventsOf .Account).map movedOut).sum = ((r.eventsOf .Account).map movedIn).sum

/-- No command sent to one account moves money between accounts. -/
theorem commands_move_nothing {s : Account.State} {command : Account.Command}
    {events : List Account.Event} (accepted : Account.decide s command = .ok events) :
    (events.map movedOut).sum = 0 ∧ (events.map movedIn).sum = 0 := by
  cases command <;> simp only [Account.decide] at accepted <;> (repeat' split at accepted) <;>
    first | cases accepted | skip
  all_goals simp [movedOut, movedIn]

/--
No transfer creates or destroys money. In every world the bank can reach,
whatever is sent to any account and whatever transfers are decided, in any
order, what transfers took out of accounts is exactly what they put into accounts.
-/
theorem noTransferCreatesMoney (w : Alchemy.World Signature) (reach : Bank.Reachable w) :
    Conserved w.toRecorded := by
  refine Bank.invariant (rule := Conserved) (by simp [Conserved, Recorded.eventsOf, Recorded.start]) ⟨?_, ?_⟩ w reach
  · intro r now s conserved
    rcases r.dispatch_cases now s with same | ⟨events, accepted, recorded⟩
    · rw [same]; exact conserved
    · obtain ⟨to, actor, command⟩ := s
      cases to
      have nothing := commands_move_nothing (s := r.state .Account (Account.key command)) accepted
      rw [recorded]
      simp only [Conserved, Recorded.eventsOf_record_self, List.map_append, List.sum_append] at *
      omega
  · intro d mem r ctx request conserved
    simp only [List.mem_singleton] at mem
    subst mem
    simp only [Recorded.decide]
    cases accepted : Transfer.decide r.state request with
    | error _ => exact conserved
    | ok records =>
      obtain ⟨_, _, _, _, rfl⟩ := transfer_accepted accepted
      simp only [Conserved, Recorded.records, List.foldl, Recorded.eventsOf_record_self,
        List.map_append, List.sum_append, List.map_cons, List.map_nil, List.sum_cons, List.sum_nil,
        movedOut, movedIn] at *
      omega

/-! ## 6. The model: every world the bank can reach

The bank is many accounts, transfers between them, a policy that reacts to
deposits, and an outside system that answers whatever it likes. The invariants
hold all the same, of every account, and of the bank as it is deployed.
-/

theorem transfer_balanced : SurvivesDecisions Balanced :=
  transfer_keeps
    (by intro s amount h _ enough; simp only [Balanced, Account.evolve] at *; omega)
    (by intro s amount h _; simp only [Balanced, Account.evolve] at *; omega)

theorem transfer_closedIsEmpty : SurvivesDecisions ClosedIsEmpty :=
  transfer_keeps
    (by intro s amount _ isOpen _; simp [ClosedIsEmpty, Account.evolve, isOpen])
    (by intro s amount _ isOpen; simp [ClosedIsEmpty, Account.evolve, isOpen])

/--
In every world the bank can reach, every account is balanced: whatever callers
send, whatever transfers are decided, whatever compliance answers, in any order
of delivery, with any event delivered twice.
-/
theorem everyAccountBalanced (w : Alchemy.World Signature) (reach : Bank.Reachable w)
    (id : String) : Balanced (w.state .Account id) :=
  Account.always (by simp [Balanced]) balanced_kept w reach id transfer_balanced

/-- And of the bank as deployed: whatever its journal holds. -/
theorem deployedAccountsBalanced (journal : List Journal.Line) (id : String) :
    Balanced ((served.replay journal).state .Account id) :=
  Account.deployed (by simp [Balanced]) balanced_kept journal id transfer_balanced

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
  (Account.deployed (by simp [ClosedIsEmpty]) closedIsEmpty_kept journal id
    transfer_closedIsEmpty : ClosedIsEmpty _) closed

/-! ## Stories and theorems, together

One scenario, written once, used three ways: a story follows it step by step for
one customer; a theorem proves its outcome for every customer; and the theorem,
given that customer, is the story's outcome again.
-/

/-- The scenario: an account is opened and funded, a payout is requested, and the wire bounces. -/
def aPayoutBounces (id owner payout : String) (held amount : Nat) : List (Model.Move Bank) := [
  .send ⟨.Account, (), .open id owner⟩,
  .send ⟨.Account, (), .deposit id held⟩,
  .send ⟨.Account, (), .requestPayout id payout amount⟩,
  .answer (.wire payout id amount) .bounced]

/--
The story: Sam's payout of 200 from 500. It follows the scenario, and says
what is seen on the way, with real values.
-/
example : Bank.follows (aPayoutBounces "a-1" "Sam" "p-1" 500 200) [
    .next 3,
    .call (.wire "p-1" "a-1" 200),
    .state .Account "a-1"
      { status := .open, owner := "Sam", balance := 300, deposited := 500, withdrawn := 200 },
    .next,
    .saga "p-1" (.failed .bounced),
    .recorded .Account "a-1" [.opened "Sam", .deposited 500, .payoutRequested "p-1" 200,
      .withdrawn 200, .deposited 200]
  ] = true := by decide

/--
The theorem: given an open account with money in it, when a payout is requested
and the wire bounces, then the money is back and the payout has failed. For
every account, owner and amount.
-/
theorem aBouncedPayoutIsRefunded (id owner payout : String) (held amount : Nat)
    (some : amount ≠ 0) (enough : amount ≤ held) (modest : held < 10000) :
    let bank := Bank.run (aPayoutBounces id owner payout held amount)
    (bank.state .Account id).balance = held ∧ bank.sagas payout = .failed .bounced := by
  behaviour [aPayoutBounces]

/-- Sam's case is one instance of the theorem: nothing is run, the values are filled in. -/
example :
    let bank := Bank.run (aPayoutBounces "a-1" "Sam" "p-1" 500 200)
    (bank.state .Account "a-1").balance = 500 ∧ bank.sagas "p-1" = .failed .bounced :=
  aBouncedPayoutIsRefunded "a-1" "Sam" "p-1" 500 200 (by decide) (by decide) (by decide)

/-! What is read from the bank. These came with the model. -/

example (log : List (Emitted Aggregates)) :
    Holdings.stateAt log () = log.foldl Holdings.step 0 := Holdings.exact log

example (log : List (Emitted Aggregates)) :
    Statement.table log = log.flatMap Statement.rows := Statement.exact log

/-! ## A story: one run, as a test -/

example : Bank.passes [
    .when ⟨.Account, (), .open "a-1" "Sam"⟩,
    .when ⟨.Account, (), .deposit "a-1" 500⟩,
    .replies ⟨.Account, (), .withdraw "a-1" 200⟩ 300,
    .when ⟨.Account, (), .withdraw "a-1" 200⟩,
    .view Holdings () 300,
    .when ⟨.Account, (), .open "a-2" "Alex"⟩,
    .decide Transfer () ⟨"a-1", "a-2", 100⟩,
    .state .Account "a-2" { status := .open, owner := "Alex", balance := 100, deposited := 100 },
    .decide Transfer () ⟨"a-1", "a-2", 5000⟩ (some (.insufficientFunds 200 5000)),
    .view Holdings () 300,
    .when ⟨.Account, (), .deposit "a-1" 25000⟩,
    .call (.screen "a-1" 25000),
    .answer (.screen "a-1" 25000) (.flagged "source of funds"),
    .recorded .Account "a-1" [.opened "Sam", .deposited 500, .withdrawn 200, .transferredOut 100,
      .deposited 25000, .frozen "source of funds"],
    .recorded .Account "a-2" [.opened "Alex", .transferredIn 100],
    .view Balances "a-2" 100,
    .when ⟨.Account, (), .withdraw "a-1" 100⟩,
    .rejected .Account (.frozen "source of funds")
  ] = true := by decide

end Bank
