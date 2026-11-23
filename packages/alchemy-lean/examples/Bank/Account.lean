import Alchemy
import Bank.Types

open Alchemy

namespace Bank

/-! ## Commands -/

structure OpenAccount where
  accountId : AccountId
  customerId : CustomerId
  owner : String
deriving DecidableEq, Repr

/-- Hand an account to another customer. Only an agent may. -/
structure ChangeOwner where
  accountId : AccountId
  customerId : CustomerId
deriving DecidableEq, Repr

structure DepositMoney where
  accountId : AccountId
  amount : Cents
deriving DecidableEq, Repr

structure WithdrawMoney where
  accountId : AccountId
  amount : Cents
deriving DecidableEq, Repr

structure FreezeAccount where
  accountId : AccountId
  reason : String
deriving DecidableEq, Repr

structure CloseAccount where
  accountId : AccountId
deriving DecidableEq, Repr

/-- Take a transfer's money out, on behalf of whoever asked for the transfer. -/
structure DebitTransfer where
  accountId : AccountId
  transferId : TransferId
  amount : Cents
  requestedBy : Actor
deriving DecidableEq, Repr

structure CreditTransfer where
  accountId : AccountId
  transferId : TransferId
  amount : Cents
deriving DecidableEq, Repr

/-- Give a transfer's money back. It reports a fact, so it is never rejected. -/
structure RefundTransfer where
  accountId : AccountId
  transferId : TransferId
  amount : Cents
deriving DecidableEq, Repr

/-- Money arrived from the payment processor. It reports a fact, so it is never rejected. -/
structure RecordSettlement where
  accountId : AccountId
  settlementId : String
  amount : Cents
deriving DecidableEq, Repr

/-- The commands an account decides. -/
inductive AccountCommand where
  | openAccount (c : OpenAccount)
  | changeOwner (c : ChangeOwner)
  | deposit (c : DepositMoney)
  | withdraw (c : WithdrawMoney)
  | freeze (c : FreezeAccount)
  | close (c : CloseAccount)
  | debitTransfer (c : DebitTransfer)
  | creditTransfer (c : CreditTransfer)
  | refundTransfer (c : RefundTransfer)
  | recordSettlement (c : RecordSettlement)
deriving DecidableEq, Repr

/-! ## Events, rejections and state -/

inductive AccountEvent where
  | accountOpened (customerId : CustomerId) (owner : String)
  | ownerChanged (previous customerId : CustomerId) (by_ : Actor)
  | moneyDeposited (amount balanceAfter : Cents)
  | moneyWithdrawn (amount balanceAfter : Cents)
  | accountFrozen (reason : String) (by_ : Actor)
  | accountClosed
  | transferDebited (transferId : TransferId) (amount balanceAfter : Cents)
  | transferCredited (transferId : TransferId) (amount balanceAfter : Cents)
  | transferRefunded (transferId : TransferId) (amount balanceAfter : Cents)
  /-- A refund arrived at an account that is no longer open. -/
  | refundStranded (transferId : TransferId) (amount : Cents)
  | settlementReceived (settlementId : String) (amount balanceAfter : Cents)
  | settlementOnClosedAccount (settlementId : String) (amount : Cents)
deriving DecidableEq, Repr

inductive AccountRejection where
  | alreadyOpen
  | notOpen
  | notOwner
  | notPermitted
  | frozen (reason : String)
  | insufficientFunds (balance requested : Cents)
  | dailyLimitExceeded (remaining : Cents)
  | balanceNotZero (balance : Cents)
deriving DecidableEq, Repr

/-- An open account. -/
structure Open where
  customerId : CustomerId
  owner : String
  balance : Cents
  /-- Why it is frozen, if it is. -/
  frozen : Option String
  /-- The day of the last withdrawal, and what was withdrawn that day. -/
  day : Nat
  withdrawn : Cents
deriving DecidableEq, Repr

inductive AccountState where
  | unopened
  | opened (account : Open)
  | closed
deriving DecidableEq, Repr

/-- The most an account may withdraw in a day, in cents. -/
def dailyLimit : Cents := 100000

/-! ## Decide and evolve -/

/-- The open account, if this actor may act on it: customers on their own, agents and the system on any. -/
def openFor (s : AccountState) (actor : Actor) : Except AccountRejection Open :=
  match s with
  | .opened account =>
    match actor with
    | .customer customerId =>
      if customerId = account.customerId then .ok account else .error .notOwner
    | _ => .ok account
  | _ => .error .notOpen

/-- What was withdrawn so far on the day of `now`. -/
def withdrawnOn (account : Open) (now : Time) : Cents :=
  if account.day = dayOf now then account.withdrawn else 0

def decideAccount (ctx : Context Actor) (s : AccountState) :
    AccountCommand → Except AccountRejection (List AccountEvent)
  | .openAccount c =>
    match s with
    | .unopened => .ok [.accountOpened c.customerId c.owner]
    | _ => .error .alreadyOpen
  | .changeOwner c =>
    match s with
    | .opened account =>
      match ctx.actor with
      | .agent _ => .ok [.ownerChanged account.customerId c.customerId ctx.actor]
      | _ => .error .notPermitted
    | _ => .error .notOpen
  | .deposit c =>
    match openFor s ctx.actor with
    | .error r => .error r
    | .ok account => .ok [.moneyDeposited c.amount (account.balance + c.amount)]
  | .withdraw c =>
    match openFor s ctx.actor with
    | .error r => .error r
    | .ok account =>
      match account.frozen with
      | some reason => .error (.frozen reason)
      | none =>
        if c.amount > account.balance then
          .error (.insufficientFunds account.balance c.amount)
        else if withdrawnOn account ctx.now + c.amount > dailyLimit then
          .error (.dailyLimitExceeded (dailyLimit - withdrawnOn account ctx.now))
        else .ok [.moneyWithdrawn c.amount (account.balance - c.amount)]
  | .freeze c =>
    match openFor s ctx.actor with
    | .error r => .error r
    | .ok account =>
      match account.frozen with
      | some _ => .ok []
      | none => .ok [.accountFrozen c.reason ctx.actor]
  | .close _ =>
    match openFor s ctx.actor with
    | .error r => .error r
    | .ok account =>
      if account.balance = 0 then .ok [.accountClosed]
      else .error (.balanceNotZero account.balance)
  | .debitTransfer c =>
    match openFor s c.requestedBy with
    | .error r => .error r
    | .ok account =>
      match account.frozen with
      | some reason => .error (.frozen reason)
      | none =>
        if c.amount > account.balance then
          .error (.insufficientFunds account.balance c.amount)
        else .ok [.transferDebited c.transferId c.amount (account.balance - c.amount)]
  | .creditTransfer c =>
    match s with
    | .opened account =>
      .ok [.transferCredited c.transferId c.amount (account.balance + c.amount)]
    | _ => .error .notOpen
  | .refundTransfer c =>
    match s with
    | .opened account =>
      .ok [.transferRefunded c.transferId c.amount (account.balance + c.amount)]
    | _ => .ok [.refundStranded c.transferId c.amount]
  | .recordSettlement c =>
    match s with
    | .opened account =>
      .ok [.settlementReceived c.settlementId c.amount (account.balance + c.amount)]
    | _ => .ok [.settlementOnClosedAccount c.settlementId c.amount]

/-- Events carry the outcome `decide` worked out, so `evolve` only copies it. -/
def evolveAccount (s : AccountState) (e : AccountEvent) (time : Time) : AccountState :=
  match s, e with
  | .unopened, .accountOpened customerId owner =>
    .opened { customerId, owner, balance := 0, frozen := none, day := 0, withdrawn := 0 }
  | .opened account, .ownerChanged _ customerId _ => .opened { account with customerId }
  | .opened account, .moneyDeposited _ balance => .opened { account with balance }
  | .opened account, .moneyWithdrawn amount balance =>
    .opened { account with
      balance, day := dayOf time, withdrawn := withdrawnOn account time + amount }
  | .opened account, .accountFrozen reason _ => .opened { account with frozen := some reason }
  | .opened _, .accountClosed => .closed
  | .opened account, .transferDebited _ _ balance => .opened { account with balance }
  | .opened account, .transferCredited _ _ balance => .opened { account with balance }
  | .opened account, .transferRefunded _ _ balance => .opened { account with balance }
  | .opened account, .settlementReceived _ _ balance => .opened { account with balance }
  | s, _ => s

def keyOfAccount : AccountCommand → AccountId
  | .openAccount c => c.accountId
  | .changeOwner c => c.accountId
  | .deposit c => c.accountId
  | .withdraw c => c.accountId
  | .freeze c => c.accountId
  | .close c => c.accountId
  | .debitTransfer c => c.accountId
  | .creditTransfer c => c.accountId
  | .refundTransfer c => c.accountId
  | .recordSettlement c => c.accountId

/-- A deposit and a withdrawal answer with the new balance. -/
def replyAccount (s : AccountState) : AccountCommand → Option Cents
  | .deposit _ | .withdraw _ =>
    match s with
    | .opened account => some account.balance
    | _ => none
  | _ => none

/-- A bank account. -/
abbrev Account : Aggregate where
  name := "Account"
  Id := AccountId
  State := AccountState
  Command := AccountCommand
  Event := AccountEvent
  Rejection := AccountRejection
  Actor := Actor
  initial := .unopened
  keyOf := keyOfAccount
  decide := decideAccount
  evolve := evolveAccount
  Reply := Option Cents
  reply := replyAccount

/-- An actor acts only on an open account, and is handed that account. -/
theorem openFor_opened {s : AccountState} {actor : Actor} {account : Open}
    (h : openFor s actor = .ok account) : s = .opened account := by
  unfold openFor at h
  split at h
  · split at h
    · split at h <;> simp_all
    · simp_all
  · simp at h

/-! ## Rules -/

/-- An open account has withdrawn no more than the daily limit. -/
def WithinDailyLimit : AccountState → Prop
  | .opened account => account.withdrawn ≤ dailyLimit
  | _ => True

/-- No command an account accepts takes it past the daily limit. -/
theorem withinDailyLimit_kept : Account.Keeps WithinDailyLimit := by
  intro ctx s c es h eq
  cases s <;> cases c <;>
    grind [→ openFor_opened, decideAccount, evolveAccount, withdrawnOn, Aggregate.apply,
      WithinDailyLimit]

/-- The rule with its proofs, as a value a model can list and name in a report. -/
def withinDailyLimit : Aggregate.Invariant Account where
  name := "WithinDailyLimit"
  holds := WithinDailyLimit
  initially := trivial
  kept := withinDailyLimit_kept

/-- Whatever an account is sent, by whoever and whenever, it stays within the daily limit. -/
theorem alwaysWithinDailyLimit (commands : List Account.Sent) :
    WithinDailyLimit (Account.replay .unopened commands) :=
  withinDailyLimit.always commands

/-- A closed account stays closed. -/
theorem aClosedAccountStaysClosed :
    Account.Transition fun _ before _ after => before = .closed → after = .closed := by
  intro ctx s c es eq closed
  subst closed
  cases c <;> grind [→ openFor_opened, decideAccount, evolveAccount, Aggregate.apply]

/-- Money leaves an account only by a withdrawal or a transfer's debit. -/
theorem moneyLeavesOnlyByWithdrawalOrTransfer :
    Account.Transition fun _ before command after =>
      ∀ b a, before = .opened b → after = .opened a →
        b.balance ≤ a.balance ∨ (∃ c, command = .withdraw c) ∨ ∃ c, command = .debitTransfer c := by
  intro ctx s c es eq
  cases s <;> cases c <;>
    grind [→ openFor_opened, decideAccount, evolveAccount, withdrawnOn, Aggregate.apply]

/-- Only an agent changes who an account belongs to. -/
theorem onlyAnAgentChangesTheOwner :
    Account.Transition fun ctx before _ after =>
      ∀ b a, before = .opened b → after = .opened a →
        b.customerId = a.customerId ∨ ∃ agentId, ctx.actor = .agent agentId := by
  intro ctx s c es eq
  cases s <;> cases c <;>
    grind [→ openFor_opened, decideAccount, evolveAccount, withdrawnOn, Aggregate.apply]

/-- A frozen account pays nothing out. -/
theorem aFrozenAccountPaysNothingOut :
    Account.Transition fun _ before _ after =>
      ∀ b a reason, before = .opened b → b.frozen = some reason → after = .opened a →
        b.balance ≤ a.balance := by
  intro ctx s c es eq
  cases s <;> cases c <;>
    grind [→ openFor_opened, decideAccount, evolveAccount, withdrawnOn, Aggregate.apply]

/-- A story with variables in it: any withdrawal the balance and the limit allow is recorded. -/
theorem withdrawsWhatIsAllowed (account : Open) (amount : Cents) (now : Time)
    (unfrozen : account.frozen = none) (enough : amount ≤ account.balance)
    (within : withdrawnOn account now + amount ≤ dailyLimit) :
    Account.decide ⟨.customer account.customerId, now⟩ (.opened account) (.withdraw ⟨"a-1", amount⟩)
      = .ok [.moneyWithdrawn amount (account.balance - amount)] := by
  grind [decideAccount, openFor]

/-! ## A story about one account, run when this file compiles -/

example : Account.story (.customer "c-1") [
    .given [.accountOpened "c-1" "Sam", .moneyDeposited 100 100],
    .when (.withdraw ⟨"a-1", 30⟩),
    .recorded [.moneyWithdrawn 30 70],
    .as (.customer "c-2"),
    .when (.withdraw ⟨"a-1", 30⟩),
    .rejected .notOwner,
    .as (.customer "c-1"),
    .when (.withdraw ⟨"a-1", 100⟩),
    .rejected (.insufficientFunds 70 100)
  ] = true := by decide

end Bank
