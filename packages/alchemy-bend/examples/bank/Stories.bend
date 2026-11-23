# Stories: examples of what the bank does. Each is the world after a sequence
# of moves; the laws in LAWS.bend say what the bank looks like in it.

import Base
import ./Types.bend as T
import ./Account.bend as Account
import ./Transfer.bend as Transfer
import ./Customer.bend as Customer
import ./Bank.bend as Bank

def sam() -> T.Actor:
  T.ByCustomer{1n}

def alex() -> T.Actor:
  T.ByCustomer{2n}

def support() -> T.Actor:
  T.ByAgent{7n}

# Account 1 is Sam's, with this much in it.
def sams_account(amount: U32) -> Bank.World():
  Bank.run([
    Bank.ToAccount{1n, sam(), Account.OpenAccount{1n}},
    Bank.ToAccount{1n, sam(), Account.DepositMoney{amount}}
  ], Bank.start())

# Account 1 is Sam's, with this much in it, and account 2 is Alex's.
def two_accounts(amount: U32) -> Bank.World():
  Bank.run([Bank.ToAccount{2n, alex(), Account.OpenAccount{2n}}], sams_account(amount))

def registering() -> Bank.World():
  Bank.run([Bank.Register{sam(), Customer.RegisterCustomer{1n, 7n}}], Bank.start())

def withdrawing() -> Bank.World():
  Bank.run([Bank.ToAccount{1n, sam(), Account.WithdrawMoney{30}}], sams_account(100))

# Two withdrawals cross the review threshold; the fraud system finds no risk.
def two_withdrawals() -> Bank.World():
  Bank.run([
    Bank.ToAccount{1n, sam(), Account.WithdrawMoney{40000}},
    Bank.ToAccount{1n, sam(), Account.WithdrawMoney{40000}},
    Bank.AnswerFraud{10n}
  ], sams_account(300000))

def the_next_day() -> Bank.World():
  Bank.run([
    Bank.Pass{86400},
    Bank.ToAccount{1n, sam(), Account.WithdrawMoney{30000}}
  ], two_withdrawals())

def frozen_by_support() -> Bank.World():
  Bank.run([
    Bank.ToAccount{1n, support(), Account.FreezeAccount{}},
    Bank.ToAccount{1n, support(), Account.FreezeAccount{}}
  ], sams_account(100))

def a_risky_withdrawal() -> Bank.World():
  Bank.run([Bank.ToAccount{1n, sam(), Account.WithdrawMoney{60000}}], sams_account(90000))

def found_risky() -> Bank.World():
  Bank.run([Bank.AnswerFraud{95n}], a_risky_withdrawal())

def split_withdrawals() -> Bank.World():
  Bank.run([
    Bank.ToAccount{1n, sam(), Account.WithdrawMoney{30000}},
    Bank.ToAccount{1n, sam(), Account.WithdrawMoney{30000}}
  ], sams_account(90000))

# The account is closed while the fraud check is pending, and found risky after.
def closed_while_checked() -> Bank.World():
  Bank.run([
    Bank.ToAccount{1n, sam(), Account.WithdrawMoney{60000}},
    Bank.ToAccount{1n, sam(), Account.CloseAccount{}},
    Bank.AnswerFraud{95n}
  ], sams_account(60000))

def a_transfer() -> Bank.World():
  Bank.run([Bank.ToTransfer{1n, sam(), Transfer.RequestTransfer{1n, 2n, 40}}], two_accounts(100))

def someone_elses_money() -> Bank.World():
  Bank.run([Bank.ToTransfer{1n, alex(), Transfer.RequestTransfer{1n, 2n, 40}}], two_accounts(100))

def a_large_transfer() -> Bank.World():
  Bank.run([Bank.ToTransfer{1n, sam(), Transfer.RequestTransfer{1n, 2n, 20000}}],
    two_accounts(50000))

def approved() -> Bank.World():
  Bank.run([
    Bank.ToTransfer{1n, support(), Transfer.ApproveTransfer{}},
    Bank.Pass{86400}
  ], a_large_transfer())

def expired() -> Bank.World():
  Bank.run([Bank.Pass{86400}], a_large_transfer())

# Alex's account is closed before Sam's transfer to it.
def to_a_closed_account() -> Bank.World():
  Bank.run([
    Bank.ToAccount{2n, alex(), Account.CloseAccount{}},
    Bank.ToTransfer{1n, sam(), Transfer.RequestTransfer{1n, 2n, 40}}
  ], two_accounts(100))

def a_settlement_on_a_closed_account() -> Bank.World():
  Bank.run([
    Bank.ToAccount{2n, alex(), Account.CloseAccount{}},
    Bank.ToAccount{2n, Bank.system(), Account.RecordSettlement{9n, 500}}
  ], two_accounts(100))

def reassigned() -> Bank.World():
  Bank.run([Bank.ToAccount{1n, support(), Account.ChangeOwner{2n}}], sams_account(100))

# One step at a time: Alex closes their account after Sam's transfer was
# debited and before it is credited, so the saga refunds it.
def closed_between_two_steps() -> Bank.World():
  Bank.steps([
    Bank.ToTransfer{1n, sam(), Transfer.RequestTransfer{1n, 2n, 40}},
    Bank.Deliver{0n},
    Bank.Advance{0n},
    Bank.ToAccount{2n, alex(), Account.CloseAccount{}},
    Bank.Advance{0n},
    Bank.Advance{0n},
    Bank.Advance{0n}
  ], two_accounts(100))

# A fault: the request for a transfer reaches the policies three times.
def requested_three_times() -> Bank.World():
  Bank.run([Bank.Redeliver{3n}, Bank.Redeliver{3n}], a_transfer())
