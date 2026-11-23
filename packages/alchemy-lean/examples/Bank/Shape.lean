import Alchemy
import Bank.Account
import Bank.Customer
import Bank.Transfer

open Alchemy

namespace Bank

/-- The aggregates of the bank. -/
inductive BankAggregate where
  | customer
  | usernameClaim
  | account
  | transfer
deriving DecidableEq, Repr

abbrev BankAggregates : Aggregates where
  Name := BankAggregate
  of
    | .customer => Customer
    | .usernameClaim => UsernameClaim
    | .account => Account
    | .transfer => Transfer

/-! ## Outside systems -/

/-- How risky the fraud-scoring system finds an account's activity, out of 100. -/
structure FraudScore where
  risk : Nat
deriving DecidableEq, Repr

structure Refunded where
  refundId : String
deriving DecidableEq, Repr

/-- The calls the bank makes to systems outside it. -/
inductive BankCall where
  /-- FraudCheck.score -/
  | fraudScore (accountId : AccountId) (amount : Cents)
  /-- Payments.refund -/
  | refund (settlementId : String) (amount : Cents)
deriving DecidableEq, Repr

abbrev BankReply : BankCall → Type
  | .fraudScore .. => FraudScore
  | .refund .. => Refunded

/-! ## The ExecuteTransfer saga -/

/-- How a large transfer's wait for approval ended. -/
inductive Approval where
  | approved
  | expired
deriving DecidableEq, Repr

structure ExecuteTransferInput where
  details : TransferDetails
  needsApproval : Bool
deriving DecidableEq, Repr

/-- Why a transfer could not be carried out. -/
inductive TransferFailure where
  | notOpen
  | notOwner
  | frozen (reason : String)
  | insufficientFunds
  | destinationClosed
  | refused
deriving DecidableEq, Repr

abbrev BankSignature : Signature where
  aggregates := BankAggregates
  Call := BankCall
  Reply := BankReply
  Saga := TransferId
  SagaInput := ExecuteTransferInput
  Signal := Approval
  Failure := TransferFailure

end Bank
