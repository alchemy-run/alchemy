# A bank account: its state, commands, events and rejections, and the two
# pure functions that define it.

import Base
import ../../Domain.bend as Domain
import ./Types.bend as T

type AccountState is Data:
  Unopened{}
  # frozen: whether it is frozen. day, withdrawn: the day of the last
  # withdrawal, and what was withdrawn that day.
  Open{customer: Nat, balance: U32, frozen: Bool, day: U32, withdrawn: U32}
  Closed{}

type AccountCommand is Data:
  OpenAccount{customer: Nat}
  # Hand the account to another customer. Only an agent may.
  ChangeOwner{customer: Nat}
  DepositMoney{amount: U32}
  WithdrawMoney{amount: U32}
  FreezeAccount{}
  CloseAccount{}
  # Take a transfer's money out, on behalf of whoever asked for the transfer.
  DebitTransfer{transfer: Nat, amount: U32, requested_by: T.Actor}
  CreditTransfer{transfer: Nat, amount: U32}
  # Give a transfer's money back. It reports a fact, so it is never rejected.
  RefundTransfer{transfer: Nat, amount: U32}
  # Money arrived from the payment processor. Never rejected.
  RecordSettlement{settlement: Nat, amount: U32}

type AccountEvent is Data:
  AccountOpened{customer: Nat}
  OwnerChanged{previous: Nat, customer: Nat}
  MoneyDeposited{amount: U32, balance_after: U32}
  MoneyWithdrawn{amount: U32, balance_after: U32}
  AccountFrozen{}
  AccountClosed{}
  TransferDebited{transfer: Nat, amount: U32, balance_after: U32}
  TransferCredited{transfer: Nat, amount: U32, balance_after: U32}
  TransferRefunded{transfer: Nat, amount: U32, balance_after: U32}
  # A refund arrived at an account that is no longer open.
  RefundStranded{transfer: Nat, amount: U32}
  SettlementReceived{settlement: Nat, amount: U32, balance_after: U32}
  SettlementOnClosedAccount{settlement: Nat, amount: U32}

type AccountRejection is Data:
  AlreadyOpen{}
  NotOpen{}
  NotOwner{}
  NotPermitted{}
  Frozen{}
  InsufficientFunds{balance: U32, requested: U32}
  DailyLimitExceeded{remaining: U32}
  BalanceNotZero{balance: U32}

def Decided() -> Data:
  Domain.Decided<AccountEvent, AccountRejection>

# The most an account may withdraw in a day, in cents.
def daily_limit() -> U32:
  100000

def initial() -> AccountState:
  Unopened{}

# What was withdrawn so far today.
def withdrawn_on(same_day: Bool, withdrawn: U32) -> U32:
  match same_day:
    case True{}:
      withdrawn
    case False{}:
      0

# Each command on an open account is decided from the checks already made, so
# that a proof can name each check.

def change_owner.go(agent: Bool, previous: Nat, customer: Nat) -> Decided():
  match agent:
    case True{}:
      Domain.Record{[OwnerChanged{previous, customer}]}
    case False{}:
      Domain.Reject{NotPermitted{}}

def deposit.go(may: Bool, balance: U32, +amount: U32) -> Decided():
  match may:
    case True{}:
      Domain.Record{[MoneyDeposited{amount, U32.add(balance, amount)}]}
    case False{}:
      Domain.Reject{NotOwner{}}

def withdraw.go(
  may: Bool, frozen: Bool, enough: Bool, within: Bool,
  +balance: U32, +used: U32, +amount: U32
) -> Decided():
  match may frozen enough within:
    case False{} _ _ _:
      Domain.Reject{NotOwner{}}
    case True{} True{} _ _:
      Domain.Reject{Frozen{}}
    case True{} False{} False{} _:
      Domain.Reject{InsufficientFunds{balance, amount}}
    case True{} False{} True{} False{}:
      Domain.Reject{DailyLimitExceeded{U32.sub(daily_limit(), used)}}
    case True{} False{} True{} True{}:
      Domain.Record{[MoneyWithdrawn{amount, U32.sub(balance, amount)}]}

def freeze.go(may: Bool, frozen: Bool) -> Decided():
  match may frozen:
    case False{} _:
      Domain.Reject{NotOwner{}}
    case True{} True{}:
      Domain.Record{[]}
    case True{} False{}:
      Domain.Record{[AccountFrozen{}]}

def close.go(may: Bool, empty: Bool, balance: U32) -> Decided():
  match may empty:
    case False{} _:
      Domain.Reject{NotOwner{}}
    case True{} False{}:
      Domain.Reject{BalanceNotZero{balance}}
    case True{} True{}:
      Domain.Record{[AccountClosed{}]}

def debit.go(
  may: Bool, frozen: Bool, enough: Bool, transfer: Nat, +balance: U32, +amount: U32
) -> Decided():
  match may frozen enough:
    case False{} _ _:
      Domain.Reject{NotOwner{}}
    case True{} True{} _:
      Domain.Reject{Frozen{}}
    case True{} False{} False{}:
      Domain.Reject{InsufficientFunds{balance, amount}}
    case True{} False{} True{}:
      Domain.Record{[TransferDebited{transfer, amount, U32.sub(balance, amount)}]}

# A command on an account that is not open.
def decide.not_open(unopened: Bool, command: AccountCommand) -> Decided():
  match unopened command:
    case True{} OpenAccount{customer}:
      Domain.Record{[AccountOpened{customer}]}
    case False{} OpenAccount{customer}:
      Domain.Reject{AlreadyOpen{}}
    case _ RefundTransfer{transfer, amount}:
      Domain.Record{[RefundStranded{transfer, amount}]}
    case _ RecordSettlement{settlement, amount}:
      Domain.Record{[SettlementOnClosedAccount{settlement, amount}]}
    case _ _:
      Domain.Reject{NotOpen{}}

# A command on an open account.
def decide.open(
  +actor: T.Actor, +today: U32,
  +customer: Nat, +balance: U32, +frozen: Bool, day: U32, withdrawn: U32,
  command: AccountCommand
) -> Decided():
  match command:
    case OpenAccount{_}:
      Domain.Reject{AlreadyOpen{}}
    case ChangeOwner{to}:
      change_owner.go(T.is_agent(actor), customer, to)
    case DepositMoney{amount}:
      deposit.go(T.may_act(actor, customer), balance, amount)
    case WithdrawMoney{+amount}:
      +used = withdrawn_on(U32.is_eq(day, today), withdrawn)
      withdraw.go(
        T.may_act(actor, customer), frozen, U32.is_le(amount, balance),
        U32.is_le(U32.add(used, amount), daily_limit()),
        balance, used, amount)
    case FreezeAccount{}:
      freeze.go(T.may_act(actor, customer), frozen)
    case CloseAccount{}:
      close.go(T.may_act(actor, customer), U32.is_eq(balance, 0), balance)
    case DebitTransfer{transfer, +amount, requested_by}:
      debit.go(T.may_act(requested_by, customer), frozen, U32.is_le(amount, balance),
        transfer, balance, amount)
    case CreditTransfer{transfer, +amount}:
      Domain.Record{[TransferCredited{transfer, amount, U32.add(balance, amount)}]}
    case RefundTransfer{transfer, +amount}:
      Domain.Record{[TransferRefunded{transfer, amount, U32.add(balance, amount)}]}
    case RecordSettlement{settlement, +amount}:
      Domain.Record{[SettlementReceived{settlement, amount, U32.add(balance, amount)}]}

def decide(context: T.Context, state: AccountState, command: AccountCommand) -> Decided():
  match context state:
    case T.Context{actor, today} Unopened{}:
      decide.not_open(True{}, command)
    case T.Context{actor, today} Closed{}:
      decide.not_open(False{}, command)
    case T.Context{actor, today} Open{customer, balance, frozen, day, withdrawn}:
      decide.open(actor, today, customer, balance, frozen, day, withdrawn, command)

# Events carry the outcome decide worked out, so evolve only copies it.
def evolve.open(
  +today: U32, customer: Nat, balance: U32, frozen: Bool, day: U32, withdrawn: U32,
  event: AccountEvent
) -> AccountState:
  match event:
    case OwnerChanged{previous, to}:
      Open{to, balance, frozen, day, withdrawn}
    case MoneyDeposited{amount, after}:
      Open{customer, after, frozen, day, withdrawn}
    case MoneyWithdrawn{amount, after}:
      Open{customer, after, frozen, today,
        U32.add(withdrawn_on(U32.is_eq(day, today), withdrawn), amount)}
    case AccountFrozen{}:
      Open{customer, balance, True{}, day, withdrawn}
    case AccountClosed{}:
      Closed{}
    case TransferDebited{transfer, amount, after}:
      Open{customer, after, frozen, day, withdrawn}
    case TransferCredited{transfer, amount, after}:
      Open{customer, after, frozen, day, withdrawn}
    case TransferRefunded{transfer, amount, after}:
      Open{customer, after, frozen, day, withdrawn}
    case SettlementReceived{settlement, amount, after}:
      Open{customer, after, frozen, day, withdrawn}
    case _:
      Open{customer, balance, frozen, day, withdrawn}

def evolve.unopened(event: AccountEvent) -> AccountState:
  match event:
    case AccountOpened{customer}:
      Open{customer, 0, False{}, 0, 0}
    case _:
      Unopened{}

def evolve(context: T.Context, state: AccountState, event: AccountEvent) -> AccountState:
  match context state:
    case T.Context{actor, today} Unopened{}:
      evolve.unopened(event)
    case T.Context{actor, today} Closed{}:
      Closed{}
    case T.Context{actor, today} Open{customer, balance, frozen, day, withdrawn}:
      evolve.open(today, customer, balance, frozen, day, withdrawn, event)

def Sent() -> Data:
  Domain.Sent<T.Context, AccountCommand>

# The state after one command: unchanged when the command is rejected.
def step(+context: T.Context, +state: AccountState, command: AccountCommand) -> AccountState:
  Domain.step(~T.Context, ~AccountState, ~AccountCommand, ~AccountEvent, ~AccountRejection,
    ~decide, ~evolve, context, state, command)

# The state after every command, in order.
def replay(commands: List<Sent()>, +state: AccountState) -> AccountState:
  Domain.replay(~T.Context, ~AccountState, ~AccountCommand, ~AccountEvent, ~AccountRejection,
    ~decide, ~evolve, commands, state)

# RULE: an open account has withdrawn no more than the daily limit.
def within_limit(state: AccountState) -> Bool:
  match state:
    case Open{customer, balance, frozen, day, withdrawn}:
      U32.is_le(withdrawn, daily_limit())
    case _:
      True{}

def is_closed(state: AccountState) -> Bool:
  match state:
    case Closed{}:
      True{}
    case _:
      False{}
