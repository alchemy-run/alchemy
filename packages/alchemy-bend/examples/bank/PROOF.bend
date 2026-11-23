# The proofs of LAWS.bend. Written by the agent; `bend PROOF.bend` checks them.

import Base
import ../../Domain.bend as Domain
import ./Types.bend as T
import ./Account.bend as Account
import ./Transfer.bend as Transfer
import ./Customer.bend as Customer
import ./Bank.bend as Bank
import ./Views.bend as Views
import ./Stories.bend as Stories
import ./Api.bend as Api
import ./LAWS.bend as Laws

# Account
# =======

# The account after a decision.
def account_after(
  +context: T.Context, +state: Account.AccountState, decided: Account.Decided()
) -> Account.AccountState:
  Domain.settle(~T.Context, ~Account.AccountState, ~Account.AccountEvent,
    ~Account.AccountRejection, ~Account.evolve, context, state, decided)

# "The account is within its limit."
def Within(state: Account.AccountState) -> Type:
  {Account.within_limit(state) == True{} : Bool}

# A command on an account that is not open keeps the limit.
def not_open_keeps(+context: T.Context, unopened: Bool, command: Account.AccountCommand)
  -> Within(account_after(context, Account.Unopened{}, Account.decide.not_open(unopened, command))):
  match context unopened command:
    case T.Context{actor, today} True{} Account.OpenAccount{customer}:
      {==}
    case T.Context{actor, today} False{} Account.OpenAccount{customer}:
      {==}
    case T.Context{actor, today} True{} Account.RefundTransfer{transfer, amount}:
      {==}
    case T.Context{actor, today} False{} Account.RefundTransfer{transfer, amount}:
      {==}
    case T.Context{actor, today} True{} Account.RecordSettlement{settlement, amount}:
      {==}
    case T.Context{actor, today} False{} Account.RecordSettlement{settlement, amount}:
      {==}
    case T.Context{actor, today} True{} Account.ChangeOwner{customer}:
      {==}
    case T.Context{actor, today} False{} Account.ChangeOwner{customer}:
      {==}
    case T.Context{actor, today} True{} Account.DepositMoney{amount}:
      {==}
    case T.Context{actor, today} False{} Account.DepositMoney{amount}:
      {==}
    case T.Context{actor, today} True{} Account.WithdrawMoney{amount}:
      {==}
    case T.Context{actor, today} False{} Account.WithdrawMoney{amount}:
      {==}
    case T.Context{actor, today} True{} Account.FreezeAccount{}:
      {==}
    case T.Context{actor, today} False{} Account.FreezeAccount{}:
      {==}
    case T.Context{actor, today} True{} Account.CloseAccount{}:
      {==}
    case T.Context{actor, today} False{} Account.CloseAccount{}:
      {==}
    case T.Context{actor, today} True{} Account.DebitTransfer{transfer, amount, by}:
      {==}
    case T.Context{actor, today} False{} Account.DebitTransfer{transfer, amount, by}:
      {==}
    case T.Context{actor, today} True{} Account.CreditTransfer{transfer, amount}:
      {==}
    case T.Context{actor, today} False{} Account.CreditTransfer{transfer, amount}:
      {==}

# A command on a closed account keeps the limit: it stays closed.
def closed_stays(+context: T.Context, command: Account.AccountCommand)
  -> {account_after(context, Account.Closed{}, Account.decide.not_open(False{}, command))
      == Account.Closed{} : Account.AccountState}:
  match context command:
    case T.Context{actor, today} Account.OpenAccount{customer}:
      {==}
    case T.Context{actor, today} Account.RefundTransfer{transfer, amount}:
      {==}
    case T.Context{actor, today} Account.RecordSettlement{settlement, amount}:
      {==}
    case T.Context{actor, today} Account.ChangeOwner{customer}:
      {==}
    case T.Context{actor, today} Account.DepositMoney{amount}:
      {==}
    case T.Context{actor, today} Account.WithdrawMoney{amount}:
      {==}
    case T.Context{actor, today} Account.FreezeAccount{}:
      {==}
    case T.Context{actor, today} Account.CloseAccount{}:
      {==}
    case T.Context{actor, today} Account.DebitTransfer{transfer, amount, by}:
      {==}
    case T.Context{actor, today} Account.CreditTransfer{transfer, amount}:
      {==}

# "An open account with this much withdrawn is within its limit."
def Under(withdrawn: U32) -> Type:
  {U32.is_le(withdrawn, Account.daily_limit()) == True{} : Bool}

def change_owner_keeps(
  +context: T.Context, agent: Bool, -customer: Nat, -balance: U32, -frozen: Bool, -day: U32,
  -withdrawn: U32, -to: Nat, old: Under(withdrawn)
) -> Within(account_after(context, Account.Open{customer, balance, frozen, day, withdrawn},
       Account.change_owner.go(agent, customer, to))):
  match context agent:
    case T.Context{actor, today} True{}:
      old
    case T.Context{actor, today} False{}:
      old

def deposit_keeps(
  +context: T.Context, may: Bool, -customer: Nat, -balance: U32, -frozen: Bool, -day: U32,
  -withdrawn: U32, -amount: U32, old: Under(withdrawn)
) -> Within(account_after(context, Account.Open{customer, balance, frozen, day, withdrawn},
       Account.deposit.go(may, balance, amount))):
  match context may:
    case T.Context{actor, today} True{}:
      old
    case T.Context{actor, today} False{}:
      old

# A withdrawal keeps the limit: it is recorded only when the check passed.
def withdraw_keeps(
  -actor: T.Actor, -today: U32, may: Bool, frozen: Bool, enough: Bool, within: Bool,
  -customer: Nat, -balance: U32, -day: U32, -withdrawn: U32, -amount: U32,
  old: Under(withdrawn),
  new: {U32.is_le(
          U32.add(Account.withdrawn_on(U32.is_eq(day, today), withdrawn), amount),
          Account.daily_limit()) == within : Bool}
) -> Within(account_after(T.Context{actor, today},
       Account.Open{customer, balance, frozen, day, withdrawn},
       Account.withdraw.go(may, frozen, enough, within, balance,
         Account.withdrawn_on(U32.is_eq(day, today), withdrawn), amount))):
  match may frozen enough within:
    case False{} True{} _ _:
      old
    case False{} False{} _ _:
      old
    case True{} True{} _ _:
      old
    case True{} False{} False{} _:
      old
    case True{} False{} True{} False{}:
      old
    case True{} False{} True{} True{}:
      new

def freeze_keeps(
  +context: T.Context, may: Bool, frozen: Bool, -customer: Nat, -balance: U32, -day: U32,
  -withdrawn: U32, old: Under(withdrawn)
) -> Within(account_after(context, Account.Open{customer, balance, frozen, day, withdrawn},
       Account.freeze.go(may, frozen))):
  match context may frozen:
    case T.Context{actor, today} False{} True{}:
      old
    case T.Context{actor, today} False{} False{}:
      old
    case T.Context{actor, today} True{} True{}:
      old
    case T.Context{actor, today} True{} False{}:
      old

def close_keeps(
  +context: T.Context, may: Bool, empty: Bool, -customer: Nat, -balance: U32, -frozen: Bool,
  -day: U32, -withdrawn: U32, old: Under(withdrawn)
) -> Within(account_after(context, Account.Open{customer, balance, frozen, day, withdrawn},
       Account.close.go(may, empty, balance))):
  match context may empty:
    case T.Context{actor, today} False{} _:
      old
    case T.Context{actor, today} True{} False{}:
      old
    case T.Context{actor, today} True{} True{}:
      {==}

def debit_keeps(
  +context: T.Context, may: Bool, frozen: Bool, enough: Bool, -customer: Nat, -balance: U32,
  -day: U32, -withdrawn: U32, -transfer: Nat, -amount: U32, old: Under(withdrawn)
) -> Within(account_after(context, Account.Open{customer, balance, frozen, day, withdrawn},
       Account.debit.go(may, frozen, enough, transfer, balance, amount))):
  match context may frozen enough:
    case T.Context{actor, today} False{} True{} _:
      old
    case T.Context{actor, today} False{} False{} _:
      old
    case T.Context{actor, today} True{} True{} _:
      old
    case T.Context{actor, today} True{} False{} False{}:
      old
    case T.Context{actor, today} True{} False{} True{}:
      old

# A command on an open account keeps the limit.
def open_keeps(
  +actor: T.Actor, +today: U32, +customer: Nat, +balance: U32, +frozen: Bool, +day: U32,
  +withdrawn: U32, command: Account.AccountCommand, old: Under(withdrawn)
) -> Within(account_after(T.Context{actor, today},
       Account.Open{customer, balance, frozen, day, withdrawn},
       Account.decide.open(actor, today, customer, balance, frozen, day, withdrawn, command))):
  match command:
    case Account.OpenAccount{to}:
      old
    case Account.ChangeOwner{to}:
      change_owner_keeps(T.Context{actor, today}, T.is_agent(actor), customer, balance, frozen,
        day, withdrawn, to, old)
    case Account.DepositMoney{amount}:
      deposit_keeps(T.Context{actor, today}, T.may_act(actor, customer), customer, balance,
        frozen, day, withdrawn, amount, old)
    case Account.WithdrawMoney{+amount}:
      withdraw_keeps(actor, today, T.may_act(actor, customer), frozen,
        U32.is_le(amount, balance),
        U32.is_le(U32.add(Account.withdrawn_on(U32.is_eq(day, today), withdrawn), amount),
          Account.daily_limit()),
        customer, balance, day, withdrawn, amount, old, {==})
    case Account.FreezeAccount{}:
      freeze_keeps(T.Context{actor, today}, T.may_act(actor, customer), frozen, customer,
        balance, day, withdrawn, old)
    case Account.CloseAccount{}:
      close_keeps(T.Context{actor, today}, T.may_act(actor, customer), U32.is_eq(balance, 0),
        customer, balance, frozen, day, withdrawn, old)
    case Account.DebitTransfer{transfer, +amount, by}:
      debit_keeps(T.Context{actor, today}, T.may_act(by, customer), frozen,
        U32.is_le(amount, balance), customer, balance, day, withdrawn, transfer, amount, old)
    case Account.CreditTransfer{transfer, amount}:
      old
    case Account.RefundTransfer{transfer, amount}:
      old
    case Account.RecordSettlement{settlement, amount}:
      old

# One command keeps the limit.
def step_keeps(
  +context: T.Context, +state: Account.AccountState, command: Account.AccountCommand,
  old: Within(state)
) -> Within(Account.step(context, state, command)):
  match context state:
    case T.Context{+actor, +today} Account.Unopened{}:
      not_open_keeps(T.Context{actor, today}, True{}, command)
    case T.Context{+actor, +today} Account.Closed{}:
      %Equal.sym(Account.AccountState,
        account_after(T.Context{actor, today}, Account.Closed{},
          Account.decide.not_open(False{}, command)),
        Account.Closed{}, closed_stays(T.Context{actor, today}, command)) : Within(_)
      {==}
    case T.Context{+actor, +today} Account.Open{+customer, +balance, +frozen, +day, +withdrawn}:
      open_keeps(actor, today, customer, balance, frozen, day, withdrawn, command, old)

# Every sequence of commands keeps the limit, by induction on the commands.
def replay_keeps(commands: List<Account.Sent()>, +state: Account.AccountState, old: Within(state))
  -> Within(Account.replay(commands, state)):
  match commands:
    case Nil{}:
      old
    case Domain.Sent{+context, +command} <> rest:
      replay_keeps(rest, Account.step(context, state, command),
        step_keeps(context, state, command, old))

def Laws.within_daily_limit(commands):
  replay_keeps(commands, Account.initial(), {==})

def Laws.a_closed_account_stays_closed(context, command):
  match context:
    case T.Context{actor, today}:
      closed_stays(T.Context{actor, today}, command)

def Laws.only_an_agent_changes_the_owner(customer, day, state, to):
  match state:
    case Account.Unopened{}:
      {==}
    case Account.Closed{}:
      {==}
    case Account.Open{owner, balance, frozen, at, withdrawn}:
      {==}

# A frozen account refuses a withdrawal, whoever asks.
def frozen_refuses(
  -actor: T.Actor, -today: U32, may: Bool, -enough: Bool, -within: Bool, -customer: Nat,
  -balance: U32, -day: U32, -withdrawn: U32, -used: U32, -amount: U32
) -> {account_after(T.Context{actor, today},
        Account.Open{customer, balance, True{}, day, withdrawn},
        Account.withdraw.go(may, True{}, enough, within, balance, used, amount))
      == Account.Open{customer, balance, True{}, day, withdrawn} : Account.AccountState}:
  match may:
    case False{}:
      {==}
    case True{}:
      {==}

def Laws.a_frozen_account_refuses_a_withdrawal(context, customer, balance, day, withdrawn, amount):
  match context:
    case T.Context{+actor, +today}:
      frozen_refuses(actor, today, T.may_act(actor, customer),
        U32.is_le(amount, balance),
        U32.is_le(U32.add(Account.withdrawn_on(U32.is_eq(day, today), withdrawn), amount),
          Account.daily_limit()),
        customer, balance, day, withdrawn,
        Account.withdrawn_on(U32.is_eq(day, today), withdrawn), amount)

# Transfer
# ========

def transfer_after(
  +context: T.Context, +state: Transfer.TransferState, decided: Transfer.Decided()
) -> Transfer.TransferState:
  Domain.settle(~T.Context, ~Transfer.TransferState, ~Transfer.TransferEvent,
    ~Transfer.TransferRejection, ~Transfer.evolve, context, state, decided)

# A late approval changes nothing, whoever sends it.
def late_stays(+context: T.Context, +state: Transfer.TransferState, agent: Bool)
  -> {transfer_after(context, state, Transfer.approve.late(agent)) == state
      : Transfer.TransferState}:
  match agent:
    case True{}:
      {==}
    case False{}:
      {==}

# A command on a transfer that has ended changes nothing.
def ended_stays(+actor: T.Actor, +day: U32, +state: Transfer.TransferState,
  command: Transfer.TransferCommand)
  -> {transfer_after(T.Context{actor, day}, state, Transfer.decide.settled(actor, False{}, command))
      == state : Transfer.TransferState}:
  match command:
    case Transfer.RequestTransfer{source, destination, amount}:
      {==}
    case Transfer.ApproveTransfer{}:
      late_stays(T.Context{actor, day}, state, T.is_agent(actor))
    case Transfer.ExpireTransfer{}:
      {==}
    case Transfer.CompleteTransfer{}:
      {==}
    case Transfer.FailTransfer{reason}:
      {==}

def Laws.a_completed_transfer_stays_completed(context, command):
  match context:
    case T.Context{+actor, +day}:
      ended_stays(actor, day, Transfer.Completed{}, command)

def Laws.a_failed_transfer_stays_failed(context, reason, command):
  match context:
    case T.Context{+actor, +day}:
      ended_stays(actor, day, Transfer.Failed{reason}, command)

# "The transfer is between two different accounts."
def Between(state: Transfer.TransferState) -> Type:
  {Transfer.between_two_accounts(state) == True{} : Bool}

# A request is recorded only between two different accounts.
def request_keeps(
  +context: T.Context, same: Bool, large: Bool, -source: Nat, -destination: Nat, -amount: U32,
  -by: T.Actor, checked: {same == Nat.is_eq(source, destination) : Bool}
) -> Between(transfer_after(context, Transfer.New{},
       Transfer.request.go(same, large, Transfer.Details{source, destination, amount, by}))):
  match context same large:
    case T.Context{actor, day} True{} _:
      {==}
    case T.Context{actor, day} False{} True{}:
      %checked : {Bool.not(_) == True{} : Bool}
      {==}
    case T.Context{actor, day} False{} False{}:
      %checked : {Bool.not(_) == True{} : Bool}
      {==}

def approve_keeps(
  +context: T.Context, agent: Bool, -details: Transfer.Details, -by: T.Actor,
  old: Between(Transfer.AwaitingApproval{details})
) -> Between(transfer_after(context, Transfer.AwaitingApproval{details},
       Transfer.approve.go(agent, details, by))):
  match context agent:
    case T.Context{actor, day} True{}:
      old
    case T.Context{actor, day} False{}:
      old

def late_keeps(+context: T.Context, +state: Transfer.TransferState, agent: Bool, old: Between(state))
  -> Between(transfer_after(context, state, Transfer.approve.late(agent))):
  match agent:
    case True{}:
      old
    case False{}:
      old

# A command on a transfer that is new keeps the rule.
def new_keeps(+actor: T.Actor, +day: U32, command: Transfer.TransferCommand)
  -> Between(transfer_after(T.Context{actor, day}, Transfer.New{},
       Transfer.decide.settled(actor, True{}, command))):
  match command:
    case Transfer.RequestTransfer{+source, +destination, +amount}:
      request_keeps(T.Context{actor, day}, Nat.is_eq(source, destination),
        U32.is_le(Transfer.approval_threshold(), amount), source, destination, amount, actor, {==})
    case Transfer.ApproveTransfer{}:
      late_keeps(T.Context{actor, day}, Transfer.New{}, T.is_agent(actor), {==})
    case Transfer.ExpireTransfer{}:
      {==}
    case Transfer.CompleteTransfer{}:
      {==}
    case Transfer.FailTransfer{reason}:
      {==}

def awaiting_keeps(
  +actor: T.Actor, +day: U32, +details: Transfer.Details, command: Transfer.TransferCommand,
  old: Between(Transfer.AwaitingApproval{details})
) -> Between(transfer_after(T.Context{actor, day}, Transfer.AwaitingApproval{details},
       Transfer.decide.awaiting(actor, details, command))):
  match command:
    case Transfer.RequestTransfer{source, destination, amount}:
      old
    case Transfer.ApproveTransfer{}:
      approve_keeps(T.Context{actor, day}, T.is_agent(actor), details, actor, old)
    case Transfer.ExpireTransfer{}:
      {==}
    case Transfer.CompleteTransfer{}:
      old
    case Transfer.FailTransfer{reason}:
      old

def pending_keeps(
  +actor: T.Actor, +day: U32, +details: Transfer.Details, command: Transfer.TransferCommand,
  old: Between(Transfer.Pending{details})
) -> Between(transfer_after(T.Context{actor, day}, Transfer.Pending{details},
       Transfer.decide.pending(actor, command))):
  match command:
    case Transfer.RequestTransfer{source, destination, amount}:
      old
    case Transfer.ApproveTransfer{}:
      late_keeps(T.Context{actor, day}, Transfer.Pending{details}, T.is_agent(actor), old)
    case Transfer.ExpireTransfer{}:
      old
    case Transfer.CompleteTransfer{}:
      {==}
    case Transfer.FailTransfer{reason}:
      {==}

# One command keeps a transfer between two accounts.
def transfer_step_keeps(
  +context: T.Context, +state: Transfer.TransferState, command: Transfer.TransferCommand,
  old: Between(state)
) -> Between(Transfer.step(context, state, command)):
  match context state:
    case T.Context{+actor, +day} Transfer.New{}:
      new_keeps(actor, day, command)
    case T.Context{+actor, +day} Transfer.AwaitingApproval{+details}:
      awaiting_keeps(actor, day, details, command, old)
    case T.Context{+actor, +day} Transfer.Pending{+details}:
      pending_keeps(actor, day, details, command, old)
    case T.Context{+actor, +day} Transfer.Completed{}:
      %Equal.sym(Transfer.TransferState,
        transfer_after(T.Context{actor, day}, Transfer.Completed{},
          Transfer.decide.settled(actor, False{}, command)),
        Transfer.Completed{}, ended_stays(actor, day, Transfer.Completed{}, command)) : Between(_)
      {==}
    case T.Context{+actor, +day} Transfer.Failed{+reason}:
      %Equal.sym(Transfer.TransferState,
        transfer_after(T.Context{actor, day}, Transfer.Failed{reason},
          Transfer.decide.settled(actor, False{}, command)),
        Transfer.Failed{reason}, ended_stays(actor, day, Transfer.Failed{reason}, command))
        : Between(_)
      {==}

def transfer_replay_keeps(
  commands: List<Transfer.Sent()>, +state: Transfer.TransferState, old: Between(state)
) -> Between(Transfer.replay(commands, state)):
  match commands:
    case Nil{}:
      old
    case Domain.Sent{+context, +command} <> rest:
      transfer_replay_keeps(rest, Transfer.step(context, state, command),
        transfer_step_keeps(context, state, command, old))

def transfer_between(world: Bank.World(), +id: Nat) -> Between(Bank.transfer(world, id)):
  transfer_replay_keeps(Bank.transfer_sends(Bank.sent_of(world), id), Transfer.initial(), {==})

def Laws.every_transfer_between_two_accounts(moves, id):
  transfer_between(Bank.steps(moves, Bank.start()), id)

# Registration
# ============

# A number is itself.
def is_eq_refl(n: Nat) -> {Nat.is_eq(n, n) == True{} : Bool}:
  match n:
    case 0n:
      {==}
    case 1n+p:
      is_eq_refl(p)

def Laws.the_name_goes_to_who_registered(id, username):
  %Equal.sym(Bool, Nat.is_eq(id, id), True{}, is_eq_refl(id)) :
    {(Customer.customer_after(Customer.New{},
        Customer.register.go(_, False{}, False{}, id, username)),
      Customer.claim_after(Customer.Free{},
        Customer.register.go(_, False{}, False{}, id, username)))
      == (Customer.Registered{username}, Customer.Claimed{id})
      : Customer.CustomerState & Customer.ClaimState}
  {==}

def taken_refuses(may: Bool, registered: Bool, -holder: Nat, -id: Nat, -username: Nat)
  -> {Customer.claim_after(Customer.Claimed{holder},
        Customer.register.go(may, registered, True{}, id, username))
      == Customer.Claimed{holder} : Customer.ClaimState}:
  match may registered:
    case False{} _:
      {==}
    case True{} True{}:
      {==}
    case True{} False{}:
      {==}

def Laws.a_claimed_name_stays_with_its_holder(actor, customer, holder, command):
  match command:
    case Customer.RegisterCustomer{+id, username}:
      taken_refuses(T.may_act(actor, id), Customer.is_registered(customer), holder, id, username)

def registered_refuses(may: Bool, -taken: Bool, -known: Nat, -id: Nat, -username: Nat)
  -> {Customer.customer_after(Customer.Registered{known},
        Customer.register.go(may, True{}, taken, id, username))
      == Customer.Registered{known} : Customer.CustomerState}:
  match may:
    case False{}:
      {==}
    case True{}:
      {==}

def Laws.a_registered_customer_stays_as_registered(actor, username, claim, command):
  match command:
    case Customer.RegisterCustomer{+id, name}:
      registered_refuses(T.may_act(actor, id), Customer.is_claimed(claim), username, id, name)

def Laws.an_unapproved_transfer_can_always_expire(context, details):
  match context:
    case T.Context{actor, day}:
      {==}

# The witness: Sam registers, then deposits.
def Laws.an_account_can_hold_money():
  ([Bank.Register{Stories.sam(), Customer.RegisterCustomer{1n, 7n}},
    Bank.ToAccount{101n, Stories.sam(), Account.DepositMoney{100}}],
   {==})

def Laws.customers_cannot_credit_an_account(id, actor, transfer, amount):
  {==}

# The bank
# ========

# Every account in a world is within its limit: its state is the commands it
# was sent, replayed, and every sequence of commands keeps the limit.
def account_within(world: Bank.World(), +id: Nat) -> Within(Bank.account(world, id)):
  replay_keeps(Bank.account_sends(Bank.sent_of(world), id), Account.initial(), {==})

def Laws.every_account_within_its_limit(moves, id):
  account_within(Bank.steps(moves, Bank.start()), id)

# Names
# =====

def Truth(b: Bool) -> Type:
  match b:
    case True{}:
      Unit
    case False{}:
      Empty

# True is not False.
def true_is_not_false(e: {True{} == False{} : Bool}) -> Empty:
  %e : Truth(_)
  Unit{}

# Two numbers that compare equal are the same number.
def eq_of_is_eq(a: Nat, b: Nat, e: {True{} == Nat.is_eq(a, b) : Bool}) -> {a == b : Nat}:
  match a b:
    case 0n 0n:
      {==}
    case 0n 1n+q:
      Empty.absurd({0n == 1n+q : Nat}, true_is_not_false(e))
    case 1n+p 0n:
      Empty.absurd({1n+p == 0n : Nat}, true_is_not_false(e))
    case 1n+p 1n+q:
      %eq_of_is_eq(p, q, e) : {1n+p == 1n+_ : Nat}
      {==}

# When two keys compare equal, their slots are held alike.
def held_alike(
  -older: +List<Customer.Registering>, -of_customer: Bool, +a: Nat, +b: Nat, flag: Bool,
  e: {flag == Nat.is_eq(a, b) : Bool}
) -> {Customer.when(flag, Customer.is_held(Customer.slot(older, of_customer, b)))
      == Customer.when(flag, Customer.is_held(Customer.slot(older, of_customer, a))) : Bool}:
  match flag:
    case False{}:
      {==}
    case True{}:
      %eq_of_is_eq(a, b, e) :
        {Customer.is_held(Customer.slot(older, of_customer, _))
          == Customer.is_held(Customer.slot(older, of_customer, a)) : Bool}
      {==}

# A slot that is not held holds nothing.
def vacant_holds_nothing(slot: Customer.Slot, -what: Nat, e: {Customer.is_held(slot) == False{} : Bool})
  -> {False{} == Customer.holds(slot, what) : Bool}:
  match slot:
    case Customer.Vacant{}:
      {==}
    case Customer.Holds{value}:
      Empty.absurd({False{} == Customer.holds(Customer.Holds{value}, what) : Bool},
        true_is_not_false(e))

def same_right(a: Bool, b: Bool, ha: {False{} == a : Bool}, h: {Customer.same(a, b) == True{} : Bool})
  -> {False{} == b : Bool}:
  match a b:
    case True{} _:
      Empty.absurd({False{} == b : Bool}, true_is_not_false(Equal.sym(Bool, False{}, True{}, ha)))
    case False{} True{}:
      Empty.absurd({False{} == True{} : Bool},
        true_is_not_false(Equal.sym(Bool, False{}, True{}, h)))
    case False{} False{}:
      {==}

def same_left(a: Bool, b: Bool, hb: {False{} == b : Bool}, h: {Customer.same(a, b) == True{} : Bool})
  -> {False{} == a : Bool}:
  match a b:
    case _ True{}:
      Empty.absurd({False{} == a : Bool}, true_is_not_false(Equal.sym(Bool, False{}, True{}, hb)))
    case True{} False{}:
      Empty.absurd({False{} == True{} : Bool},
        true_is_not_false(Equal.sym(Bool, False{}, True{}, h)))
    case False{} False{}:
      {==}

# One registration keeps the names in agreement. cs is what the customer
# asked about held before, and lu what the name asked about held.
def agree_step(
  may: Bool, reg: Bool, taken: Bool, sc: Bool, su: Bool,
  +id: Nat, +username: Nat, +c: Nat, +u: Nat, +cs: Customer.Slot, +lu: Customer.Slot,
  ih: {Customer.same(Customer.holds(cs, u), Customer.holds(lu, c)) == True{} : Bool},
  hsc: {sc == Nat.is_eq(id, c) : Bool},
  hsu: {su == Nat.is_eq(username, u) : Bool},
  fc: {Customer.when(sc, Customer.is_held(cs)) == Customer.when(sc, reg) : Bool},
  fu: {Customer.when(su, Customer.is_held(lu)) == Customer.when(su, taken) : Bool}
) -> {Customer.same(
        Customer.holds(Customer.slot_next(
          Customer.is_accepted(Customer.register.go(may, reg, taken, id, username)),
          sc, username, cs), u),
        Customer.holds(Customer.slot_next(
          Customer.is_accepted(Customer.register.go(may, reg, taken, id, username)),
          su, id, lu), c)) == True{} : Bool}:
  match may reg taken sc su:
    case False{} _ _ _ _:
      ih
    case True{} True{} _ _ _:
      ih
    case True{} False{} True{} _ _:
      ih
    case True{} False{} False{} False{} False{}:
      ih
    case True{} False{} False{} True{} True{}:
      %hsu : {Customer.same(_, Nat.is_eq(id, c)) == True{} : Bool}
      %hsc : {Customer.same(True{}, _) == True{} : Bool}
      {==}
    case True{} False{} False{} True{} False{}:
      %hsu : {Customer.same(_, Customer.holds(lu, c)) == True{} : Bool}
      %same_right(Customer.holds(cs, u), Customer.holds(lu, c),
          vacant_holds_nothing(cs, u, fc), ih)
        : {Customer.same(False{}, _) == True{} : Bool}
      {==}
    case True{} False{} False{} False{} True{}:
      %hsc : {Customer.same(Customer.holds(cs, u), _) == True{} : Bool}
      %same_left(Customer.holds(cs, u), Customer.holds(lu, c),
          vacant_holds_nothing(lu, c, fu), ih)
        : {Customer.same(_, False{}) == True{} : Bool}
      {==}

# Every list of registrations leaves the names in agreement.
def agree(sent: +List<Customer.Registering>, +c: Nat, +u: Nat)
  -> {Customer.names_agree(sent, c, u) == True{} : Bool}:
  match sent:
    case Nil{}:
      {==}
    case Customer.Registering{actor, Customer.RegisterCustomer{+id, +username}} <> +older:
      agree_step(
        T.may_act(actor, id),
        Customer.is_held(Customer.slot(older, True{}, id)),
        Customer.is_held(Customer.slot(older, False{}, username)),
        Nat.is_eq(id, c), Nat.is_eq(username, u),
        id, username, c, u,
        Customer.slot(older, True{}, c), Customer.slot(older, False{}, u),
        agree(older, c, u), {==}, {==},
        held_alike(older, True{}, id, c, Nat.is_eq(id, c), {==}),
        held_alike(older, False{}, username, u, Nat.is_eq(username, u), {==}))

def Laws.names_always_agree(moves, id, name):
  agree(Bank.registrations_of(Bank.steps(moves, Bank.start())), id, name)

# Stories
# =======
#
# A story is proved by running it.

def Laws.registering.customer():
  {==}

def Laws.registering.username():
  {==}

def Laws.registering.main_account():
  {==}

def Laws.registering.dashboard():
  {==}

def Laws.a_taken_username():
  {==}

def Laws.registering_someone_else():
  {==}

def Laws.withdrawing.events():
  {==}

def Laws.withdrawing.summary():
  {==}

def Laws.withdrawing.statement():
  {==}

def Laws.an_overdraft():
  {==}

def Laws.someone_elses_account():
  {==}

def Laws.the_daily_limit.today():
  {==}

def Laws.the_daily_limit.tomorrow():
  {==}

def Laws.freezing_twice():
  {==}

def Laws.a_risky_withdrawal.call():
  {==}

def Laws.a_risky_withdrawal.frozen():
  {==}

def Laws.a_risky_withdrawal.refused():
  {==}

def Laws.split_withdrawals():
  {==}

def Laws.closed_while_checked.events():
  {==}

def Laws.closed_while_checked.summary():
  {==}

def Laws.a_transfer.source():
  {==}

def Laws.a_transfer.destination():
  {==}

def Laws.a_transfer.transfer():
  {==}

def Laws.a_transfer.saga():
  {==}

def Laws.a_transfer.status():
  {==}

def Laws.a_transfer.shown_on_both():
  {==}

def Laws.someone_elses_money.account():
  {==}

def Laws.someone_elses_money.transfer():
  {==}

def Laws.a_large_transfer.waits():
  {==}

def Laws.a_large_transfer.customers_cannot_approve():
  {==}

def Laws.a_large_transfer.approved():
  {==}

def Laws.an_unapproved_transfer_expires():
  {==}

def Laws.an_unapproved_transfer_expires.too_late():
  {==}

def Laws.to_a_closed_account.refunded():
  {==}

def Laws.to_a_closed_account.failed():
  {==}

def Laws.closed_between_two_steps():
  {==}

def Laws.requested_three_times():
  {==}

def Laws.a_settlement_on_a_closed_account():
  {==}

def Laws.reassigning.customers_cannot():
  {==}

def Laws.reassigning.dashboards():
  {==}

def Laws.reassigning.activity():
  {==}

def Laws.the_ledger_is_private.owner():
  {==}

def Laws.the_ledger_is_private.another_customer():
  {==}

def Laws.the_account_card():
  {==}

