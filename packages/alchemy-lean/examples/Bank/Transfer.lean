import Alchemy
import Bank.Types

open Alchemy

namespace Bank

/-- Transfers of at least this many cents wait for a support agent's approval. -/
def approvalThreshold : Cents := 10000

/-- What a transfer moves, and for whom. -/
structure TransferDetails where
  source : AccountId
  destination : AccountId
  amount : Cents
  requestedBy : Actor
deriving DecidableEq, Repr

structure RequestTransfer where
  transferId : TransferId
  source : AccountId
  destination : AccountId
  amount : Cents
deriving DecidableEq, Repr

/-- A support agent approves a large transfer before its approval window closes. -/
structure ApproveTransfer where
  transferId : TransferId
deriving DecidableEq, Repr

/-- The approval window closed. It reports a fact, so it is never rejected. -/
structure ExpireTransfer where
  transferId : TransferId
deriving DecidableEq, Repr

/-- Reports an outcome, so it is never rejected. -/
structure CompleteTransfer where
  transferId : TransferId
deriving DecidableEq, Repr

/-- Reports an outcome, so it is never rejected. -/
structure FailTransfer where
  transferId : TransferId
  reason : String
deriving DecidableEq, Repr

inductive TransferCommand where
  | request (c : RequestTransfer)
  | approve (c : ApproveTransfer)
  | expire (c : ExpireTransfer)
  | complete (c : CompleteTransfer)
  | fail (c : FailTransfer)
deriving DecidableEq, Repr

inductive TransferEvent where
  | transferRequested (details : TransferDetails) (needsApproval : Bool)
  | transferApproved (details : TransferDetails) (approvedBy : Actor)
  | transferCompleted
  | transferFailed (reason : String)
deriving DecidableEq, Repr

inductive TransferRejection where
  | alreadyRequested
  | sameAccount
  | notPermitted
  | notAwaitingApproval
deriving DecidableEq, Repr

inductive TransferState where
  | new
  | awaitingApproval (details : TransferDetails)
  | pending (details : TransferDetails)
  | completed
  | failed (reason : String)
deriving DecidableEq, Repr

def decideTransfer (ctx : Context Actor) (s : TransferState) :
    TransferCommand → Except TransferRejection (List TransferEvent)
  | .request c =>
    match s with
    | .new =>
      if c.source = c.destination then .error .sameAccount
      else
        .ok [.transferRequested ⟨c.source, c.destination, c.amount, ctx.actor⟩
          (decide (c.amount ≥ approvalThreshold))]
    | _ => .error .alreadyRequested
  | .approve _ =>
    match ctx.actor with
    | .agent _ =>
      match s with
      | .awaitingApproval details => .ok [.transferApproved details ctx.actor]
      | _ => .error .notAwaitingApproval
    | _ => .error .notPermitted
  | .expire _ =>
    match s with
    | .awaitingApproval _ => .ok [.transferFailed "not approved in time"]
    | _ => .ok []
  | .complete _ =>
    match s with
    | .pending _ => .ok [.transferCompleted]
    | _ => .ok []
  | .fail c =>
    match s with
    | .pending _ => .ok [.transferFailed c.reason]
    | _ => .ok []

def evolveTransfer (_ : TransferState) (e : TransferEvent) (_ : Time) : TransferState :=
  match e with
  | .transferRequested details needsApproval =>
    if needsApproval then .awaitingApproval details else .pending details
  | .transferApproved details _ => .pending details
  | .transferCompleted => .completed
  | .transferFailed reason => .failed reason

/--
A transfer between two accounts. Large transfers wait for approval until their
window closes; approval and expiry are commands on this one instance, so exactly
one of them wins.
-/
abbrev Transfer : Aggregate where
  name := "Transfer"
  Id := TransferId
  State := TransferState
  Command := TransferCommand
  Event := TransferEvent
  Rejection := TransferRejection
  Actor := Actor
  initial := .new
  keyOf
    | .request c => c.transferId
    | .approve c => c.transferId
    | .expire c => c.transferId
    | .complete c => c.transferId
    | .fail c => c.transferId
  decide := decideTransfer
  evolve := evolveTransfer

/-! ## Rules -/

/-- Whether a transfer has ended. -/
def Ended : TransferState → Prop
  | .completed | .failed _ => True
  | _ => False

/-- A transfer that ended stays as it ended: nothing completes a failed one, or fails a completed one. -/
theorem anEndedTransferStaysAsItEnded :
    Transfer.Transition fun _ before _ after => Ended before → after = before := by
  intro ctx s c es eq ended
  cases s <;> cases c <;> grind [decideTransfer, evolveTransfer, Aggregate.apply, Ended]

/-- A transfer moves between two different accounts. -/
def BetweenTwoAccounts : TransferState → Prop
  | .awaitingApproval details | .pending details => details.source ≠ details.destination
  | _ => True

/-- No command a transfer accepts makes it a transfer from an account to itself. -/
theorem betweenTwoAccounts_kept : Transfer.Keeps BetweenTwoAccounts := by
  intro ctx s c es h eq
  cases s <;> cases c <;>
    grind [decideTransfer, evolveTransfer, Aggregate.apply, BetweenTwoAccounts]

def betweenTwoAccounts : Aggregate.Invariant Transfer where
  name := "BetweenTwoAccounts"
  holds := BetweenTwoAccounts
  initially := trivial
  kept := betweenTwoAccounts_kept

/-- Only an agent approves a transfer. -/
theorem onlyAnAgentApproves :
    Transfer.Transition fun ctx before _ after =>
      ∀ details, before = .awaitingApproval details → after = .pending details →
        ∃ agentId, ctx.actor = .agent agentId := by
  intro ctx s c es eq
  cases s <;> cases c <;> grind [decideTransfer, evolveTransfer, Aggregate.apply]

/-- Approval and expiry race, and exactly one wins: once expired, approval is refused. -/
theorem expiryBeatsALateApproval (ctx ctx' : Context Actor) (details : TransferDetails)
    (expire : ExpireTransfer) (approve : ApproveTransfer) :
    let expired := Transfer.step ctx (.awaitingApproval details) (.expire expire)
    (∃ r, Transfer.decide ctx' expired (.approve approve) = .error r) := by
  cases h : ctx'.actor <;> simp [Aggregate.step, decideTransfer, evolveTransfer, Aggregate.apply, h]

/-- No transfer waits for ever: one that waits for approval can always be expired, whoever asks. -/
theorem anUnapprovedTransferCanAlwaysExpire (ctx : Context Actor) (details : TransferDetails)
    (expire : ExpireTransfer) :
    Transfer.step ctx (.awaitingApproval details) (.expire expire)
      = .failed "not approved in time" := by
  simp [Aggregate.step, decideTransfer, evolveTransfer, Aggregate.apply]

end Bank
