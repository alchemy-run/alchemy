# What is read from the bank. Each read is a function of the log of recorded
# events, so it can never disagree with what was recorded.

import Base
import ./Types.bend as T
import ./Account.bend as Account
import ./Transfer.bend as Transfer
import ./Customer.bend as Customer
import ./Bank.bend as Bank

# Customers read what is theirs; agents read anything. Nobody owns what
# nobody opened.
def must_own(actor: T.Actor, opened: Bool, owner: Nat) -> Bool:
  match actor opened:
    case T.ByAgent{id} _:
      True{}
    case _ False{}:
      True{}
    case T.ByCustomer{id} True{}:
      Nat.is_eq(id, owner)
    case T.BySystem{id} True{}:
      False{}

# What a guarded read answers.
type Read<-A: Data> is Data:
  Forbidden{}
  Allowed{value: A}

# Streams of events
# =================

def account_events.keep(same: Bool, event: Account.AccountEvent, rest: +List<Account.AccountEvent>)
  -> +List<Account.AccountEvent>:
  match same:
    case True{}:
      event <> rest
    case False{}:
      rest

# The events one account recorded, in order.
def account_events(log: +List<Bank.Emitted>, +id: Nat) -> +List<Account.AccountEvent>:
  match log:
    case Nil{}:
      []
    case Bank.FromAccount{on, event, day, seq} <> rest:
      account_events.keep(Nat.is_eq(on, id), event, account_events(rest, id))
    case _ <> rest:
      account_events(rest, id)

def transfer_events.keep(
  same: Bool, event: Transfer.TransferEvent, rest: +List<Transfer.TransferEvent>
) -> +List<Transfer.TransferEvent>:
  match same:
    case True{}:
      event <> rest
    case False{}:
      rest

# The events one transfer recorded, in order.
def transfer_events(log: +List<Bank.Emitted>, +id: Nat) -> +List<Transfer.TransferEvent>:
  match log:
    case Nil{}:
      []
    case Bank.FromTransfer{on, event} <> rest:
      transfer_events.keep(Nat.is_eq(on, id), event, transfer_events(rest, id))
    case _ <> rest:
      transfer_events(rest, id)

# AccountSummary
# ==============

# An account at a glance.
type Summary is Data:
  Summary{opened: Bool, customer: Nat, balance: U32, frozen: Bool, closed: Bool}

def no_summary() -> Summary:
  Summary{False{}, 0n, 0, False{}, False{}}

def summarize(summary: Summary, event: Account.AccountEvent) -> Summary:
  match summary event:
    case Summary{opened, customer, balance, frozen, closed} Account.AccountOpened{to}:
      Summary{True{}, to, balance, frozen, closed}
    case Summary{opened, customer, balance, frozen, closed} Account.OwnerChanged{previous, to}:
      Summary{opened, to, balance, frozen, closed}
    case Summary{opened, customer, balance, frozen, closed} Account.MoneyDeposited{amount, after}:
      Summary{opened, customer, after, frozen, closed}
    case Summary{opened, customer, balance, frozen, closed} Account.MoneyWithdrawn{amount, after}:
      Summary{opened, customer, after, frozen, closed}
    case Summary{opened, customer, balance, frozen, closed} Account.TransferDebited{t, amount, after}:
      Summary{opened, customer, after, frozen, closed}
    case Summary{opened, customer, balance, frozen, closed} Account.TransferCredited{t, amount, after}:
      Summary{opened, customer, after, frozen, closed}
    case Summary{opened, customer, balance, frozen, closed} Account.TransferRefunded{t, amount, after}:
      Summary{opened, customer, after, frozen, closed}
    case Summary{opened, customer, balance, frozen, closed} Account.SettlementReceived{s, amount, after}:
      Summary{opened, customer, after, frozen, closed}
    case Summary{opened, customer, balance, frozen, closed} Account.AccountFrozen{}:
      Summary{opened, customer, balance, True{}, closed}
    case Summary{opened, customer, balance, frozen, closed} Account.AccountClosed{}:
      Summary{opened, customer, balance, frozen, True{}}
    case s _:
      s

def summary_in(events: +List<Account.AccountEvent>, summary: Summary) -> Summary:
  match events:
    case Nil{}:
      summary
    case event <> rest:
      summary_in(rest, summarize(summary, event))

# An account's summary.
def summary(log: +List<Bank.Emitted>, id: Nat) -> Summary:
  summary_in(account_events(log, id), no_summary())

def guard_summary(may: Bool, summary: Summary) -> Read<Summary>:
  match may:
    case True{}:
      Allowed{summary}
    case False{}:
      Forbidden{}

def owned_by(actor: T.Actor, summary: Summary) -> Bool:
  match summary:
    case Summary{opened, customer, balance, frozen, closed}:
      must_own(actor, opened, customer)

# An account's summary, for its owner and agents.
def read_summary(actor: T.Actor, +log: +List<Bank.Emitted>, +id: Nat) -> Read<Summary>:
  guard_summary(owned_by(actor, summary(log, id)), summary(log, id))

# Statement
# =========

type LineKind is Data:
  Deposit{}
  Withdrawal{}
  TransferIn{}
  TransferOut{}
  RefundIn{}
  Settlement{}

type Line is Data:
  Line{kind: LineKind, amount: U32, balance: U32}

# An account's money events as statement lines.
def lines(events: +List<Account.AccountEvent>) -> +List<Line>:
  match events:
    case Nil{}:
      []
    case Account.MoneyDeposited{amount, after} <> rest:
      Line{Deposit{}, amount, after} <> lines(rest)
    case Account.MoneyWithdrawn{amount, after} <> rest:
      Line{Withdrawal{}, amount, after} <> lines(rest)
    case Account.TransferCredited{t, amount, after} <> rest:
      Line{TransferIn{}, amount, after} <> lines(rest)
    case Account.TransferDebited{t, amount, after} <> rest:
      Line{TransferOut{}, amount, after} <> lines(rest)
    case Account.TransferRefunded{t, amount, after} <> rest:
      Line{RefundIn{}, amount, after} <> lines(rest)
    case Account.SettlementReceived{s, amount, after} <> rest:
      Line{Settlement{}, amount, after} <> lines(rest)
    case _ <> rest:
      lines(rest)

def statement(log: +List<Bank.Emitted>, id: Nat) -> +List<Line>:
  lines(account_events(log, id))

# AccountLedger: one account's ledger, for its owner and agents. The Ledger
# projection gives it every money event the accounts record.
def guard_lines(may: Bool, rows: +List<Line>) -> Read<+List<Line>>:
  match may:
    case True{}:
      Allowed{rows}
    case False{}:
      Forbidden{}

def account_ledger(actor: T.Actor, +log: +List<Bank.Emitted>, +id: Nat) -> Read<+List<Line>>:
  guard_lines(owned_by(actor, summary(log, id)), statement(log, id))

# AccountActivity
# ===============

# What support needs to see about an account.
def activity(events: +List<Account.AccountEvent>) -> +List<Account.AccountEvent>:
  match events:
    case Nil{}:
      []
    case Account.AccountFrozen{} <> rest:
      Account.AccountFrozen{} <> activity(rest)
    case Account.AccountClosed{} <> rest:
      Account.AccountClosed{} <> activity(rest)
    case Account.OwnerChanged{previous, to} <> rest:
      Account.OwnerChanged{previous, to} <> activity(rest)
    case Account.RefundStranded{t, amount} <> rest:
      Account.RefundStranded{t, amount} <> activity(rest)
    case Account.SettlementOnClosedAccount{s, amount} <> rest:
      Account.SettlementOnClosedAccount{s, amount} <> activity(rest)
    case _ <> rest:
      activity(rest)

def guard_events(may: Bool, events: +List<Account.AccountEvent>)
  -> Read<+List<Account.AccountEvent>>:
  match may:
    case True{}:
      Allowed{events}
    case False{}:
      Forbidden{}

# Agents only.
def read_activity(actor: T.Actor, log: +List<Bank.Emitted>, id: Nat)
  -> Read<+List<Account.AccountEvent>>:
  guard_events(T.is_agent(actor), activity(account_events(log, id)))

# AccountCard
# ===========

# A card for an account: a log per account that clients follow. The
# AccountCards projection appends one on every change to the summary.
type Card is Data:
  Card{customer: Nat, balance: U32, frozen: Bool}

def changes_the_card(event: Account.AccountEvent) -> Bool:
  match event:
    case Account.MoneyDeposited{amount, after}:
      True{}
    case Account.MoneyWithdrawn{amount, after}:
      True{}
    case Account.TransferDebited{t, amount, after}:
      True{}
    case Account.TransferCredited{t, amount, after}:
      True{}
    case Account.TransferRefunded{t, amount, after}:
      True{}
    case Account.SettlementReceived{s, amount, after}:
      True{}
    case Account.AccountFrozen{}:
      True{}
    case _:
      False{}

def card_of(summary: Summary) -> Card:
  match summary:
    case Summary{opened, customer, balance, frozen, closed}:
      Card{customer, balance, frozen}

def cards.keep(changed: Bool, card: Card, rest: +List<Card>) -> +List<Card>:
  match changed:
    case True{}:
      card <> rest
    case False{}:
      rest

def cards_in(events: +List<Account.AccountEvent>, +summary: Summary) -> +List<Card>:
  match events:
    case Nil{}:
      []
    case +event <> rest:
      cards.keep(changes_the_card(event), card_of(summarize(summary, event)),
        cards_in(rest, summarize(summary, event)))

def cards(log: +List<Bank.Emitted>, id: Nat) -> +List<Card>:
  cards_in(account_events(log, id), no_summary())

# CustomerDashboard
# =================

# One of a customer's accounts, and its balance.
type Holding is Data:
  Holding{account: Nat, balance: U32}

def holdings.keep(mine: Bool, account: Nat, balance: U32, rest: +List<Holding>) -> +List<Holding>:
  match mine:
    case True{}:
      Holding{account, balance} <> rest
    case False{}:
      rest

def holding_of(+customer: Nat, +account: Nat, summary: Summary, rest: +List<Holding>)
  -> +List<Holding>:
  match summary:
    case Summary{opened, owner, balance, frozen, closed}:
      holdings.keep(opened && Nat.is_eq(owner, customer) && Bool.not(closed), account, balance,
        rest)

# A customer's open accounts among these, with their balances. An ownership
# change moves an account between dashboards, because the summary follows it.
def dashboard(accounts: List<Nat>, +log: +List<Bank.Emitted>, +customer: Nat) -> +List<Holding>:
  match accounts:
    case Nil{}:
      []
    case +account <> rest:
      holding_of(customer, account, summary(log, account), dashboard(rest, log, customer))

# TransferStatus
# ==============

type Progress is Data:
  NotRequested{}
  AwaitingApproval{}
  Pending{}
  InFlight{}
  Completed{}
  Failed{reason: Transfer.Reason}

def progress.debited(debited: Bool, waiting: Progress) -> Progress:
  match debited:
    case True{}:
      InFlight{}
    case False{}:
      waiting

def progress_of(state: Transfer.TransferState, debited: Bool) -> Progress:
  match state:
    case Transfer.New{}:
      NotRequested{}
    case Transfer.AwaitingApproval{details}:
      AwaitingApproval{}
    case Transfer.Pending{details}:
      progress.debited(debited, Pending{})
    case Transfer.Completed{}:
      Completed{}
    case Transfer.Failed{reason}:
      Failed{reason}

def was_debited(log: +List<Bank.Emitted>, +transfer: Nat) -> Bool:
  match log:
    case Nil{}:
      False{}
    case Bank.FromAccount{on, Account.TransferDebited{t, amount, after}, day, seq} <> rest:
      Nat.is_eq(t, transfer) || was_debited(rest, transfer)
    case _ <> rest:
      was_debited(rest, transfer)

# Where a transfer stands, from the transfer's events and the accounts'.
def transfer_status(+world: Bank.World(), +transfer: Nat) -> Progress:
  progress_of(Bank.transfer(world, transfer), was_debited(Bank.log_of(world), transfer))

# AccountTransfers
# ================

type Moved is Data:
  Moved{transfer: Nat, amount: U32, incoming: Bool}

def moved.one(out: Bool, into: Bool, +transfer: Nat, +amount: U32, rest: +List<Moved>)
  -> +List<Moved>:
  match out into:
    case True{} True{}:
      Moved{transfer, amount, False{}} <> Moved{transfer, amount, True{}} <> rest
    case True{} False{}:
      Moved{transfer, amount, False{}} <> rest
    case False{} True{}:
      Moved{transfer, amount, True{}} <> rest
    case False{} False{}:
      rest

# The transfers in and out of an account: one transfer shows on both accounts.
def moved(log: +List<Bank.Emitted>, +account: Nat) -> +List<Moved>:
  match log:
    case Nil{}:
      []
    case Bank.FromTransfer{id, Transfer.TransferRequested{Transfer.Details{source, destination, amount, by}, needs}} <> rest:
      moved.one(Nat.is_eq(source, account), Nat.is_eq(destination, account), id, amount,
        moved(rest, account))
    case _ <> rest:
      moved(rest, account)
