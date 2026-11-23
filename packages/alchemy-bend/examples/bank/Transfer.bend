# A transfer between two accounts. Large transfers wait for approval until
# their window closes; approval and expiry are commands on this one instance,
# so exactly one of them wins.

import Base
import ../../Domain.bend as Domain
import ./Types.bend as T

# What a transfer moves, and for whom.
type Details is Data:
  Details{source: Nat, destination: Nat, amount: U32, requested_by: T.Actor}

# Why a transfer failed.
type Reason is Data:
  NotApprovedInTime{}
  SourceNotOpen{}
  NotYourAccount{}
  SourceFrozen{}
  InsufficientFunds{}
  DestinationNotOpen{}
  Refused{}

type TransferState is Data:
  New{}
  AwaitingApproval{details: Details}
  Pending{details: Details}
  Completed{}
  Failed{reason: Reason}

type TransferCommand is Data:
  RequestTransfer{source: Nat, destination: Nat, amount: U32}
  # A support agent approves a large transfer before its window closes.
  ApproveTransfer{}
  # The approval window closed. It reports a fact, so it is never rejected.
  ExpireTransfer{}
  # Reports an outcome, so it is never rejected.
  CompleteTransfer{}
  FailTransfer{reason: Reason}

type TransferEvent is Data:
  TransferRequested{details: Details, needs_approval: Bool}
  TransferApproved{details: Details, approved_by: T.Actor}
  TransferCompleted{}
  TransferFailed{reason: Reason}

type TransferRejection is Data:
  AlreadyRequested{}
  SameAccount{}
  NotPermitted{}
  NotAwaitingApproval{}

def Decided() -> Data:
  Domain.Decided<TransferEvent, TransferRejection>

# Transfers of at least this many cents wait for a support agent's approval.
def approval_threshold() -> U32:
  10000

def initial() -> TransferState:
  New{}

def request.go(same: Bool, large: Bool, details: Details) -> Decided():
  match same:
    case True{}:
      Domain.Reject{SameAccount{}}
    case False{}:
      Domain.Record{[TransferRequested{details, large}]}

def approve.go(agent: Bool, details: Details, by: T.Actor) -> Decided():
  match agent:
    case True{}:
      Domain.Record{[TransferApproved{details, by}]}
    case False{}:
      Domain.Reject{NotPermitted{}}

# An approval of a transfer that is not waiting for one.
def approve.late(agent: Bool) -> Decided():
  match agent:
    case True{}:
      Domain.Reject{NotAwaitingApproval{}}
    case False{}:
      Domain.Reject{NotPermitted{}}

# A command on a transfer that is neither waiting for approval nor pending.
def decide.settled(+actor: T.Actor, is_new: Bool, command: TransferCommand) -> Decided():
  match is_new command:
    case True{} RequestTransfer{+source, +destination, +amount}:
      request.go(Nat.is_eq(source, destination), U32.is_le(approval_threshold(), amount),
        Details{source, destination, amount, actor})
    case False{} RequestTransfer{source, destination, amount}:
      Domain.Reject{AlreadyRequested{}}
    case _ ApproveTransfer{}:
      approve.late(T.is_agent(actor))
    case _ _:
      Domain.Record{[]}

def decide.awaiting(+actor: T.Actor, details: Details, command: TransferCommand) -> Decided():
  match command:
    case RequestTransfer{source, destination, amount}:
      Domain.Reject{AlreadyRequested{}}
    case ApproveTransfer{}:
      approve.go(T.is_agent(actor), details, actor)
    case ExpireTransfer{}:
      Domain.Record{[TransferFailed{NotApprovedInTime{}}]}
    case _:
      Domain.Record{[]}

def decide.pending(+actor: T.Actor, command: TransferCommand) -> Decided():
  match command:
    case RequestTransfer{source, destination, amount}:
      Domain.Reject{AlreadyRequested{}}
    case ApproveTransfer{}:
      approve.late(T.is_agent(actor))
    case ExpireTransfer{}:
      Domain.Record{[]}
    case CompleteTransfer{}:
      Domain.Record{[TransferCompleted{}]}
    case FailTransfer{reason}:
      Domain.Record{[TransferFailed{reason}]}

def decide(context: T.Context, state: TransferState, command: TransferCommand) -> Decided():
  match context state:
    case T.Context{actor, day} New{}:
      decide.settled(actor, True{}, command)
    case T.Context{actor, day} AwaitingApproval{details}:
      decide.awaiting(actor, details, command)
    case T.Context{actor, day} Pending{details}:
      decide.pending(actor, command)
    case T.Context{actor, day} Completed{}:
      decide.settled(actor, False{}, command)
    case T.Context{actor, day} Failed{reason}:
      decide.settled(actor, False{}, command)

def requested(needs_approval: Bool, details: Details) -> TransferState:
  match needs_approval:
    case True{}:
      AwaitingApproval{details}
    case False{}:
      Pending{details}

def evolve(context: T.Context, state: TransferState, event: TransferEvent) -> TransferState:
  match event:
    case TransferRequested{details, needs_approval}:
      requested(needs_approval, details)
    case TransferApproved{details, approved_by}:
      Pending{details}
    case TransferCompleted{}:
      Completed{}
    case TransferFailed{reason}:
      Failed{reason}

def Sent() -> Data:
  Domain.Sent<T.Context, TransferCommand>

def step(+context: T.Context, +state: TransferState, command: TransferCommand) -> TransferState:
  Domain.step(~T.Context, ~TransferState, ~TransferCommand, ~TransferEvent, ~TransferRejection,
    ~decide, ~evolve, context, state, command)

def replay(commands: List<Sent()>, +state: TransferState) -> TransferState:
  Domain.replay(~T.Context, ~TransferState, ~TransferCommand, ~TransferEvent, ~TransferRejection,
    ~decide, ~evolve, commands, state)

def distinct(details: Details) -> Bool:
  match details:
    case Details{source, destination, amount, requested_by}:
      Bool.not(Nat.is_eq(source, destination))

# RULE: a transfer moves between two different accounts.
def between_two_accounts(state: TransferState) -> Bool:
  match state:
    case AwaitingApproval{details}:
      distinct(details)
    case Pending{details}:
      distinct(details)
    case _:
      True{}
