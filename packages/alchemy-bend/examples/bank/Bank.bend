# The bank: every aggregate, the registration decision, the policies, the
# ExecuteTransfer saga, the calls to outside systems and the clock.
#
# The bank says what its commands, events, saga steps and outside calls are,
# and gives the engine in Model.bend four functions: what a command records
# (`emit`), what the policies do about an event (`react`), what a saga step
# does (`advance`), and what an answer from outside does (`answer`). The
# engine gives back the world, `step`, `play` and `run`.

import Base
import ../../Domain.bend as Domain
import ../../Model.bend as Model
import ./Types.bend as T
import ./Account.bend as Account
import ./Transfer.bend as Transfer
import ./Customer.bend as Customer

# A command, with who sends it and to what.
type Command is Data:
  ForAccount{id: Nat, actor: T.Actor, command: Account.AccountCommand}
  ForTransfer{id: Nat, actor: T.Actor, command: Transfer.TransferCommand}
  # The registration decision: it records on a customer and on a username.
  ForRegistration{actor: T.Actor, command: Customer.RegisterCustomer}

# An event one instance recorded. An account's says when, and where it sits in
# the log.
type Emitted is Data:
  FromAccount{id: Nat, event: Account.AccountEvent, time: U32, seq: Nat}
  FromTransfer{id: Nat, event: Transfer.TransferEvent}
  FromCustomer{id: Nat, event: Customer.CustomerEvent}
  FromClaim{username: Nat, event: Customer.ClaimEvent}

# A call to a system outside the bank, waiting for its answer.
type Call is Data:
  # FraudCheck.score
  FraudScore{account: Nat, total: U32}
  # Payments.refund
  Refund{settlement: Nat, amount: U32}

# What a system outside the bank answers. It answers the oldest waiting call,
# if that call is one of its own.
type Answer is Data:
  FraudAnswer{risk: Nat}
  RefundAnswer{}

# The next step of the ExecuteTransfer saga for one transfer.
type Work is Data:
  Debit{transfer: Nat, details: Transfer.Details}
  Credit{transfer: Nat, details: Transfer.Details}
  # The compensation: give back what was debited.
  GiveBack{transfer: Nat, details: Transfer.Details}
  Complete{transfer: Nat}
  Abort{transfer: Nat, reason: Transfer.Reason}

# Where the saga stands for one transfer.
type Run is Data:
  WaitingForApproval{}
  Running{}
  Finished{}
  FailedBecause{reason: Transfer.Reason}

type SagaRun is Data:
  SagaRun{transfer: Nat, run: Run}

def World() -> Data:
  Model.World<Command, Emitted, Work, Call, SagaRun>

def start() -> World():
  Model.start(Command, Emitted, Work, Call, SagaRun)

# What the policies and the saga act as.
def system() -> T.Actor:
  T.BySystem{0n}

# The account opened for a customer when they register.
def main_account(customer: Nat) -> Nat:
  Nat.add(100n, customer)

# How long a support agent has to approve a large transfer: 24 hours.
def approval_window() -> U32:
  86400

# Daily outflow above which an account's activity is reviewed, in cents.
def review_threshold() -> U32:
  50000

# The fraud score above which an account is frozen, out of 100.
def risk_limit() -> Nat:
  80n

# Reading the world
# =================

def now_of(world: World()) -> U32:
  Model.now_of(Command, Emitted, Work, Call, SagaRun, world)

def sent_of(world: World()) -> +List<Model.Stamped<Command>>:
  Model.sent_of(Command, Emitted, Work, Call, SagaRun, world)

def log_of(world: World()) -> +List<Emitted>:
  Model.log_of(Command, Emitted, Work, Call, SagaRun, world)

def calls_of(world: World()) -> +List<Call>:
  Model.calls_of(Command, Emitted, Work, Call, SagaRun, world)

def account_sends.keep(same: Bool, sent: Account.Sent(), rest: List<Account.Sent()>)
  -> List<Account.Sent()>:
  match same:
    case True{}:
      sent <> rest
    case False{}:
      rest

# The commands one account was sent, in order, each with its context.
def account_sends(sent: +List<Model.Stamped<Command>>, +id: Nat) -> List<Account.Sent()>:
  match sent:
    case Nil{}:
      []
    case Model.Stamped{time, ForAccount{to, actor, command}} <> rest:
      account_sends.keep(Nat.is_eq(to, id),
        Domain.Sent{T.Context{actor, T.day(time)}, command}, account_sends(rest, id))
    case _ <> rest:
      account_sends(rest, id)

# An account's state: the commands it was sent, replayed.
def account(world: World(), id: Nat) -> Account.AccountState:
  Account.replay(account_sends(sent_of(world), id), Account.initial())

def transfer_sends.keep(same: Bool, sent: Transfer.Sent(), rest: List<Transfer.Sent()>)
  -> List<Transfer.Sent()>:
  match same:
    case True{}:
      sent <> rest
    case False{}:
      rest

def transfer_sends(sent: +List<Model.Stamped<Command>>, +id: Nat) -> List<Transfer.Sent()>:
  match sent:
    case Nil{}:
      []
    case Model.Stamped{time, ForTransfer{to, actor, command}} <> rest:
      transfer_sends.keep(Nat.is_eq(to, id),
        Domain.Sent{T.Context{actor, T.day(time)}, command}, transfer_sends(rest, id))
    case _ <> rest:
      transfer_sends(rest, id)

# A transfer's state: the commands it was sent, replayed.
def transfer(world: World(), id: Nat) -> Transfer.TransferState:
  Transfer.replay(transfer_sends(sent_of(world), id), Transfer.initial())

def registrations(sent: +List<Model.Stamped<Command>>, newest: +List<Customer.Registering>)
  -> +List<Customer.Registering>:
  match sent:
    case Nil{}:
      newest
    case Model.Stamped{time, ForRegistration{actor, command}} <> rest:
      registrations(rest, Customer.Registering{actor, command} <> newest)
    case _ <> rest:
      registrations(rest, newest)

# Every registration that was sent, newest first.
def registrations_of(world: World()) -> +List<Customer.Registering>:
  registrations(sent_of(world), [])

# A customer's state: the registrations that were sent, decided in order.
def customer(world: World(), id: Nat) -> Customer.CustomerState:
  Customer.customer_of(registrations_of(world), id)

def claim(world: World(), username: Nat) -> Customer.ClaimState:
  Customer.claim_of(registrations_of(world), username)

def run_in.pick(same: Bool, found: Run, earlier: Maybe<&2, Run>) -> Maybe<&2, Run>:
  match same:
    case True{}:
      Some{found}
    case False{}:
      earlier

def run_in(sagas: +List<SagaRun>, +id: Nat, found: Maybe<&2, Run>) -> Maybe<&2, Run>:
  match sagas:
    case Nil{}:
      found
    case SagaRun{transfer, run} <> rest:
      run_in(rest, id, run_in.pick(Nat.is_eq(transfer, id), run, found))

# Where the saga stands for a transfer: None when it never started.
def saga(world: World(), id: Nat) -> Maybe<&2, Run>:
  run_in(Model.runs_of(Command, Emitted, Work, Call, SagaRun, world), id, None{})

def add_work(world: World(), next: Work) -> World():
  Model.add_work(Command, Emitted, Work, Call, SagaRun, world, next)

def add_call(world: World(), call: Call) -> World():
  Model.add_call(Command, Emitted, Work, Call, SagaRun, world, call)

def with_calls(world: World(), calls: +List<Call>) -> World():
  Model.with_calls(Command, Emitted, Work, Call, SagaRun, world, calls)

# A transfer's run stands here from now on.
def set_run(world: World(), id: Nat, run: Run) -> World():
  Model.add_run(Command, Emitted, Work, Call, SagaRun, world, SagaRun{id, run})

# What commands record
# ====================

def emit_account(events: +List<Account.AccountEvent>, +id: Nat, +time: U32, +seq: Nat)
  -> +List<Emitted>:
  match events:
    case Nil{}:
      []
    case e <> rest:
      FromAccount{id, e, time, seq} <> emit_account(rest, id, time, 1n+seq)

def emit_transfer(events: +List<Transfer.TransferEvent>, +id: Nat) -> +List<Emitted>:
  match events:
    case Nil{}:
      []
    case e <> rest:
      FromTransfer{id, e} <> emit_transfer(rest, id)

def events_of(decided: Account.Decided()) -> +List<Account.AccountEvent>:
  match decided:
    case Domain.Reject{why}:
      []
    case Domain.Record{events}:
      events

def transfer_events_of(decided: Transfer.Decided()) -> +List<Transfer.TransferEvent>:
  match decided:
    case Domain.Reject{why}:
      []
    case Domain.Record{events}:
      events

# The context a command is sent in now.
def context(world: World(), actor: T.Actor) -> T.Context:
  T.Context{actor, T.day(now_of(world))}

# What an account answers a command, as things stand.
def ask_account(+world: World(), +id: Nat, actor: T.Actor, command: Account.AccountCommand)
  -> Account.Decided():
  Account.decide(context(world, actor), account(world, id), command)

def ask_transfer(+world: World(), +id: Nat, actor: T.Actor, command: Transfer.TransferCommand)
  -> Transfer.Decided():
  Transfer.decide(context(world, actor), transfer(world, id), command)

# What a registration answers, as things stand.
def ask_register(+world: World(), actor: T.Actor, command: Customer.RegisterCustomer)
  -> Customer.Registration:
  match command:
    case Customer.RegisterCustomer{+id, +username}:
      Customer.register(actor, customer(world, id), claim(world, username),
        Customer.RegisterCustomer{id, username})

def emit_registration(id: Nat, username: Nat, registration: Customer.Registration)
  -> +List<Emitted>:
  match registration:
    case Customer.Refused{why}:
      []
    case Customer.Accepted{on_customer, on_claim}:
      [FromCustomer{id, on_customer}, FromClaim{username, on_claim}]

# What a command records, as things stand: nothing, when it is rejected.
def emit(+world: World(), +command: Command) -> +List<Emitted>:
  match command:
    case ForAccount{+id, actor, command}:
      emit_account(events_of(ask_account(world, id, actor, command)), id, now_of(world),
        List.length(&2, Emitted, log_of(world)))
    case ForTransfer{+id, actor, command}:
      emit_transfer(transfer_events_of(ask_transfer(world, id, actor, command)), id)
    case ForRegistration{actor, Customer.RegisterCustomer{+id, +username}}:
      emit_registration(id, username,
        ask_register(world, actor, Customer.RegisterCustomer{id, username}))

def send(+world: World(), +command: Command) -> World():
  Model.send(~Command, ~Emitted, ~Work, ~Call, ~SagaRun, ~emit, world, command)

def send_account(+world: World(), id: Nat, actor: T.Actor, command: Account.AccountCommand)
  -> World():
  send(world, ForAccount{id, actor, command})

def send_transfer(+world: World(), id: Nat, actor: T.Actor, command: Transfer.TransferCommand)
  -> World():
  send(world, ForTransfer{id, actor, command})

# The ExecuteTransfer saga
# ========================
#
# Moves money between two accounts on behalf of the requester: debits the
# source, credits the destination, and refunds the debit if the credit fails.
# The outcome is recorded on the Transfer either way. Each step is taken on
# its own, so anything may happen between two of them.

# Why a debit was refused, as a reason the transfer failed.
def why_not_debited(why: Account.AccountRejection) -> Transfer.Reason:
  match why:
    case Account.NotOpen{}:
      Transfer.SourceNotOpen{}
    case Account.NotOwner{}:
      Transfer.NotYourAccount{}
    case Account.Frozen{}:
      Transfer.SourceFrozen{}
    case Account.InsufficientFunds{balance, requested}:
      Transfer.InsufficientFunds{}
    case _:
      Transfer.Refused{}

def debit.next(world: World(), +id: Nat, details: Transfer.Details, answer: Account.Decided())
  -> World():
  match answer:
    case Domain.Reject{why}:
      add_work(world, Abort{id, why_not_debited(why)})
    case Domain.Record{events}:
      add_work(world, Credit{id, details})

def credit.next(world: World(), +id: Nat, details: Transfer.Details, answer: Account.Decided())
  -> World():
  match answer:
    case Domain.Reject{why}:
      add_work(world, GiveBack{id, details})
    case Domain.Record{events}:
      add_work(world, Complete{id})

# One step of the saga.
def advance(+world: World(), work: Work) -> World():
  match work:
    # Debit first: if the credit fails, the money is refunded, so it is never created.
    case Debit{+id, Transfer.Details{+source, +destination, +amount, +by}}:
      debit.next(
        send_account(world, source, system(), Account.DebitTransfer{id, amount, by}),
        id, Transfer.Details{source, destination, amount, by},
        ask_account(world, source, system(), Account.DebitTransfer{id, amount, by}))
    case Credit{+id, Transfer.Details{+source, +destination, +amount, +by}}:
      credit.next(
        send_account(world, destination, system(), Account.CreditTransfer{id, amount}),
        id, Transfer.Details{source, destination, amount, by},
        ask_account(world, destination, system(), Account.CreditTransfer{id, amount}))
    case GiveBack{+id, Transfer.Details{source, destination, amount, by}}:
      add_work(send_account(world, source, system(), Account.RefundTransfer{id, amount}),
        Abort{id, Transfer.DestinationNotOpen{}})
    case Complete{+id}:
      set_run(send_transfer(world, id, system(), Transfer.CompleteTransfer{}), id, Finished{})
    case Abort{+id, +reason}:
      set_run(send_transfer(world, id, system(), Transfer.FailTransfer{reason}), id,
        FailedBecause{reason})

# Policies
# ========

# TransferExecution and TransferApprovalDeadline, for a transfer whose run has
# not started: a small one starts at once; a large one waits, and is set to
# expire if nobody approves it in time. An event delivered twice starts nothing.
def on_requested(
  +world: World(), +id: Nat, details: Transfer.Details, needs_approval: Bool,
  run: Maybe<&2, Run>
) -> World():
  match needs_approval run:
    case _ Some{earlier}:
      world
    case False{} None{}:
      add_work(set_run(world, id, Running{}), Debit{id, details})
    case True{} None{}:
      Model.later(Command, Emitted, Work, Call, SagaRun, set_run(world, id, WaitingForApproval{}),
        approval_window(), ForTransfer{id, system(), Transfer.ExpireTransfer{}})

# An approval starts the run that waited for it, once.
def on_approved(+world: World(), +id: Nat, details: Transfer.Details, run: Maybe<&2, Run>) -> World():
  match run:
    case Some{WaitingForApproval{}}:
      add_work(set_run(world, id, Running{}), Debit{id, details})
    case _:
      world

# A transfer that expired while its run waited ends the run.
def on_failed(+world: World(), +id: Nat, run: Maybe<&2, Run>) -> World():
  match run:
    case Some{WaitingForApproval{}}:
      set_run(world, id, Finished{})
    case _:
      world

def react_transfer(+world: World(), +id: Nat, event: Transfer.TransferEvent) -> World():
  match event:
    case Transfer.TransferRequested{details, needs_approval}:
      on_requested(world, id, details, needs_approval, saga(world, id))
    case Transfer.TransferApproved{details, approved_by}:
      on_approved(world, id, details, saga(world, id))
    case Transfer.TransferFailed{reason}:
      on_failed(world, id, saga(world, id))
    case Transfer.TransferCompleted{}:
      world

def outflow.one(counts: Bool, event: Account.AccountEvent) -> U32:
  match counts event:
    case True{} Account.MoneyWithdrawn{amount, after}:
      amount
    case True{} Account.TransferDebited{transfer, amount, after}:
      amount
    case _ _:
      0

# DailyOutflow: the money out of an account on a day.
def outflow(log: +List<Emitted>, +id: Nat, +day: U32) -> U32:
  match log:
    case Nil{}:
      0
    case FromAccount{on, event, time, seq} <> rest:
      U32.add(outflow.one(Nat.is_eq(on, id) && U32.is_eq(T.day(time), day), event),
        outflow(rest, id, day))
    case _ <> rest:
      outflow(rest, id, day)

def take(log: +List<Emitted>, n: Nat) -> +List<Emitted>:
  match log n:
    case Nil{} _:
      []
    case e <> rest 0n:
      []
    case e <> rest 1n+p:
      e <> take(rest, p)

def review.go(world: World(), crossed: Bool, id: Nat, total: U32) -> World():
  match crossed:
    case True{}:
      add_call(world, FraudScore{id, total})
    case False{}:
      world

# FraudReview: when an account's outflow for the day crosses the threshold,
# ask the fraud system to score it. Split withdrawals are caught too.
def review(+world: World(), +id: Nat, +amount: U32, +time: U32, seq: Nat) -> World():
  +before = outflow(take(log_of(world), seq), id, T.day(time))
  review.go(world,
    U32.is_lt(before, review_threshold()) && U32.is_le(review_threshold(), U32.add(before, amount)),
    id, U32.add(before, amount))

def react_account(+world: World(), +id: Nat, event: Account.AccountEvent, +time: U32, seq: Nat)
  -> World():
  match event:
    case Account.MoneyWithdrawn{amount, after}:
      review(world, id, amount, time, seq)
    case Account.TransferDebited{transfer, amount, after}:
      review(world, id, amount, time, seq)
    # SettlementRefund: money that settles on a closed account is refunded.
    case Account.SettlementOnClosedAccount{settlement, amount}:
      add_call(world, Refund{settlement, amount})
    case _:
      world

# What the policies do about one event.
def react(+world: World(), event: Emitted) -> World():
  match event:
    # MainAccountProvisioning: whenever a customer registers, open their main account.
    case FromCustomer{+id, Customer.CustomerRegistered{username}}:
      send_account(world, main_account(id), system(), Account.OpenAccount{id})
    case FromClaim{username, e}:
      world
    case FromTransfer{id, e}:
      react_transfer(world, id, e)
    case FromAccount{id, e, time, seq}:
      react_account(world, id, e, time, seq)

# Answers from outside
# ====================

def answer_fraud.freeze(+world: World(), risky: Bool, account: Nat) -> World():
  match risky:
    case True{}:
      send_account(world, account, system(), Account.FreezeAccount{})
    case False{}:
      world

def answer_fraud(+world: World(), calls: +List<Call>, risk: Nat) -> World():
  match calls:
    case FraudScore{account, total} <> rest:
      answer_fraud.freeze(with_calls(world, rest), Nat.is_lt(risk_limit(), risk), account)
    case _:
      world

def answer_refund(+world: World(), calls: +List<Call>) -> World():
  match calls:
    case Refund{settlement, amount} <> rest:
      with_calls(world, rest)
    case _:
      world

def answer(+world: World(), given: Answer) -> World():
  match given:
    case FraudAnswer{risk}:
      answer_fraud(world, calls_of(world), risk)
    case RefundAnswer{}:
      answer_refund(world, calls_of(world))

# Moves
# =====

# What can happen to the bank, one thing at a time.
type Move is Data:
  ToAccount{id: Nat, actor: T.Actor, command: Account.AccountCommand}
  ToTransfer{id: Nat, actor: T.Actor, command: Transfer.TransferCommand}
  Register{actor: T.Actor, command: Customer.RegisterCustomer}
  # The undelivered event at this place in the inbox reaches the policies.
  Deliver{index: Nat}
  # A fault: the event at this place in the log reaches the policies again.
  Redeliver{seq: Nat}
  # The saga step at this place in the work takes place.
  Advance{index: Nat}
  # The fraud system answers the oldest waiting call, if it is one of its own.
  AnswerFraud{risk: Nat}
  # The payment processor answers the oldest waiting call, if it is one of its own.
  AnswerRefund{}
  Pass{seconds: U32}

# The move, as the engine takes it.
def to_model(move: Move) -> Model.Move<Command, Answer>:
  match move:
    case ToAccount{id, actor, command}:
      Model.Send{ForAccount{id, actor, command}}
    case ToTransfer{id, actor, command}:
      Model.Send{ForTransfer{id, actor, command}}
    case Register{actor, command}:
      Model.Send{ForRegistration{actor, command}}
    case Deliver{index}:
      Model.Deliver{index}
    case Redeliver{seq}:
      Model.Redeliver{seq}
    case Advance{index}:
      Model.Advance{index}
    case AnswerFraud{risk}:
      Model.Answer{FraudAnswer{risk}}
    case AnswerRefund{}:
      Model.Answer{RefundAnswer{}}
    case Pass{seconds}:
      Model.Pass{seconds}

# One thing happens.
def step(+world: World(), move: Move) -> World():
  Model.step(~Command, ~Emitted, ~Work, ~Call, ~SagaRun, ~Answer, ~emit, ~react, ~advance, ~answer,
    world, to_model(move))

# The world after a move, once everything that follows from it has run.
def play(+world: World(), move: Move) -> World():
  Model.play(~Command, ~Emitted, ~Work, ~Call, ~SagaRun, ~Answer, ~emit, ~react, ~advance, ~answer,
    world, to_model(move))

# The world after every step, in order: nothing is delivered or advanced
# unless a step says so.
def steps(moves: List<Move>, +world: World()) -> World():
  match moves:
    case Nil{}:
      world
    case move <> rest:
      steps(rest, step(world, move))

# The world after every move, each followed by everything that follows from it.
def run(moves: List<Move>, +world: World()) -> World():
  match moves:
    case Nil{}:
      world
    case move <> rest:
      run(rest, play(world, move))
