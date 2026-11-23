# The Apis: what each audience may send. Who is asking is the actor each move
# carries, so a session is an argument, not a setting.

import Base
import ./Types.bend as T
import ./Account.bend as Account
import ./Transfer.bend as Transfer
import ./Customer.bend as Customer
import ./Bank.bend as Bank

# What customers may send: register, deposit, withdraw, close, ask for a transfer.
def customer_api(move: Bank.Move) -> Bool:
  match move:
    case Bank.Register{actor, command}:
      True{}
    case Bank.ToAccount{id, actor, Account.DepositMoney{amount}}:
      True{}
    case Bank.ToAccount{id, actor, Account.WithdrawMoney{amount}}:
      True{}
    case Bank.ToAccount{id, actor, Account.CloseAccount{}}:
      True{}
    case Bank.ToTransfer{id, actor, Transfer.RequestTransfer{source, destination, amount}}:
      True{}
    case _:
      False{}

# What support agents may send: freeze, reassign, approve.
def support_api(move: Bank.Move) -> Bool:
  match move:
    case Bank.ToAccount{id, actor, Account.FreezeAccount{}}:
      True{}
    case Bank.ToAccount{id, actor, Account.ChangeOwner{customer}}:
      True{}
    case Bank.ToTransfer{id, actor, Transfer.ApproveTransfer{}}:
      True{}
    case _:
      False{}
