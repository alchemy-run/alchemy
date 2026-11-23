# The rules of the bank. A person states them; PROOF.bend must prove them.

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

# The account
# ===========

# RULE: whatever an account is sent, by whoever, on whatever days, it never
# withdraws more than the daily limit in a day.
law within_daily_limit:
  for commands: List<Account.Sent()>
  {Account.within_limit(Account.replay(commands, Account.initial())) == True{} : Bool}

# RULE: a closed account stays closed, whatever it is sent.
law a_closed_account_stays_closed:
  for context: T.Context
  for command: Account.AccountCommand
  {Account.step(context, Account.Closed{}, command) == Account.Closed{} : Account.AccountState}

# RULE: only an agent changes who an account belongs to.
law only_an_agent_changes_the_owner:
  for customer: Nat
  for day: U32
  for state: Account.AccountState
  for to: Nat
  {Account.step(T.Context{T.ByCustomer{customer}, day}, state, Account.ChangeOwner{to}) == state
    : Account.AccountState}

# RULE: a frozen account pays nothing out.
law a_frozen_account_refuses_a_withdrawal:
  for context: T.Context
  for customer: Nat
  for balance: U32
  for day: U32
  for withdrawn: U32
  for amount: U32
  {Account.step(context, Account.Open{customer, balance, True{}, day, withdrawn},
      Account.WithdrawMoney{amount})
    == Account.Open{customer, balance, True{}, day, withdrawn} : Account.AccountState}

# The transfer
# ============

# RULE: a transfer that completed stays completed, whatever it is sent.
law a_completed_transfer_stays_completed:
  for context: T.Context
  for command: Transfer.TransferCommand
  {Transfer.step(context, Transfer.Completed{}, command) == Transfer.Completed{}
    : Transfer.TransferState}

# RULE: a transfer that failed stays failed, for the reason it failed.
law a_failed_transfer_stays_failed:
  for context: T.Context
  for reason: Transfer.Reason
  for command: Transfer.TransferCommand
  {Transfer.step(context, Transfer.Failed{reason}, command) == Transfer.Failed{reason}
    : Transfer.TransferState}

# RULE (eventually): no transfer waits for ever. One that waits for approval
# is ended by expiry, whoever sends it and whenever.
law an_unapproved_transfer_can_always_expire:
  for context: T.Context
  for details: Transfer.Details
  {Transfer.step(context, Transfer.AwaitingApproval{details}, Transfer.ExpireTransfer{})
    == Transfer.Failed{Transfer.NotApprovedInTime{}} : Transfer.TransferState}

# Registration
# ============

# RULE: the username goes to the customer who registered under it.
law the_name_goes_to_who_registered:
  for +id: Nat
  for +username: Nat
  {(Customer.customer_after(Customer.New{},
      Customer.register(T.ByCustomer{id}, Customer.New{}, Customer.Free{},
        Customer.RegisterCustomer{id, username})),
    Customer.claim_after(Customer.Free{},
      Customer.register(T.ByCustomer{id}, Customer.New{}, Customer.Free{},
        Customer.RegisterCustomer{id, username})))
    == (Customer.Registered{username}, Customer.Claimed{id})
    : Customer.CustomerState & Customer.ClaimState}

# RULE: once somebody holds a name, no registration gives it to anybody else.
law a_claimed_name_stays_with_its_holder:
  for actor: T.Actor
  for customer: Customer.CustomerState
  for holder: Nat
  for command: Customer.RegisterCustomer
  {Customer.claim_after(Customer.Claimed{holder},
      Customer.register(actor, customer, Customer.Claimed{holder}, command))
    == Customer.Claimed{holder} : Customer.ClaimState}

# RULE: a registered customer is not registered again.
law a_registered_customer_stays_as_registered:
  for actor: T.Actor
  for username: Nat
  for claim: Customer.ClaimState
  for command: Customer.RegisterCustomer
  {Customer.customer_after(Customer.Registered{username},
      Customer.register(actor, Customer.Registered{username}, claim, command))
    == Customer.Registered{username} : Customer.CustomerState}

# The bank
# ========
#
# These hold after any sequence of steps: whatever callers send, whichever
# event is delivered next or delivered again, whichever saga step runs next,
# whatever the outside systems answer, and however much time passes.

# RULE: no account in the bank ever withdraws more than the daily limit.
law every_account_within_its_limit:
  for moves: List<Bank.Move>
  for id: Nat
  {Account.within_limit(Bank.account(Bank.steps(moves, Bank.start()), id)) == True{} : Bool}

# RULE: every transfer in the bank is between two different accounts.
law every_transfer_between_two_accounts:
  for moves: List<Bank.Move>
  for id: Nat
  {Transfer.between_two_accounts(Bank.transfer(Bank.steps(moves, Bank.start()), id)) == True{}
    : Bool}

# RULE: a customer is registered under a name exactly when that name is
# claimed for them. So no two customers hold one name, and nobody is
# registered under a name they do not hold.
law names_always_agree:
  for moves: List<Bank.Move>
  for +id: Nat
  for +name: Nat
  {Customer.names_agree(Bank.registrations_of(Bank.steps(moves, Bank.start())), id, name)
    == True{} : Bool}

# RULE (sometimes): the bank can be used. Some sequence of moves leaves a
# customer with money in an account.
law an_account_can_hold_money:
  exs moves: List<Bank.Move>
  {Bank.account(Bank.run(moves, Bank.start()), 101n)
    == Account.Open{1n, 100, False{}, 0, 0} : Account.AccountState}

# RULE: customers cannot credit an account, whichever one and however much.
law customers_cannot_credit_an_account:
  for id: Nat
  for actor: T.Actor
  for transfer: Nat
  for amount: U32
  {Api.customer_api(Bank.ToAccount{id, actor, Account.CreditTransfer{transfer, amount}})
    == False{} : Bool}

# Stories
# =======
#
# Each law says what the bank looks like after a story in Stories.bend.

# STORY: registering claims the username with it, then opens a main account.
law registering.customer:
  {Bank.customer(Stories.registering(), 1n) == Customer.Registered{7n} : Customer.CustomerState}

law registering.username:
  {Bank.claim(Stories.registering(), 7n) == Customer.Claimed{1n} : Customer.ClaimState}

law registering.main_account:
  {Views.account_events(Bank.log_of(Stories.registering()), 101n)
    == [Account.AccountOpened{1n}] : +List<Account.AccountEvent>}

law registering.dashboard:
  {Views.dashboard([101n], Bank.log_of(Stories.registering()), 1n)
    == [Views.Holding{101n, 0}] : +List<Views.Holding>}

# STORY: a taken username rejects the registration.
law a_taken_username:
  {Bank.ask_register(Stories.registering(), Stories.alex(), Customer.RegisterCustomer{2n, 7n})
    == Customer.Refused{Customer.UsernameTaken{}} : Customer.Registration}

# STORY: a customer may only register themselves.
law registering_someone_else:
  {Bank.ask_register(Bank.start(), Stories.alex(), Customer.RegisterCustomer{1n, 7n})
    == Customer.Refused{Customer.NotTheCustomer{}} : Customer.Registration}

# STORY: withdraw updates the account, its summary and its statement.
law withdrawing.events:
  {Views.account_events(Bank.log_of(Stories.withdrawing()), 1n)
    == [Account.AccountOpened{1n}, Account.MoneyDeposited{100, 100},
        Account.MoneyWithdrawn{30, 70}] : +List<Account.AccountEvent>}

law withdrawing.summary:
  {Views.summary(Bank.log_of(Stories.withdrawing()), 1n)
    == Views.Summary{True{}, 1n, 70, False{}, False{}} : Views.Summary}

law withdrawing.statement:
  {Views.statement(Bank.log_of(Stories.withdrawing()), 1n)
    == [Views.Line{Views.Deposit{}, 100, 100}, Views.Line{Views.Withdrawal{}, 30, 70}]
    : +List<Views.Line>}

# STORY: an overdraft is rejected with evidence.
law an_overdraft:
  {Bank.ask_account(Stories.sams_account(50), 1n, Stories.sam(), Account.WithdrawMoney{80})
    == Domain.Reject{Account.InsufficientFunds{50, 80}} : Account.Decided()}

# STORY: a customer can't withdraw from someone else's account.
law someone_elses_account:
  {Bank.ask_account(Stories.sams_account(100), 1n, Stories.alex(), Account.WithdrawMoney{30})
    == Domain.Reject{Account.NotOwner{}} : Account.Decided()}

# STORY: the daily limit follows the clock.
law the_daily_limit.today:
  {Bank.ask_account(Stories.two_withdrawals(), 1n, Stories.sam(), Account.WithdrawMoney{30000})
    == Domain.Reject{Account.DailyLimitExceeded{20000}} : Account.Decided()}

law the_daily_limit.tomorrow:
  {Bank.account(Stories.the_next_day(), 1n)
    == Account.Open{1n, 190000, False{}, 1, 30000} : Account.AccountState}

# STORY: freezing twice records one event.
law freezing_twice:
  {Views.account_events(Bank.log_of(Stories.frozen_by_support()), 1n)
    == [Account.AccountOpened{1n}, Account.MoneyDeposited{100, 100}, Account.AccountFrozen{}]
    : +List<Account.AccountEvent>}

# STORY: a risky withdrawal freezes the account, once the fraud system answers.
law a_risky_withdrawal.call:
  {Bank.calls_of(Stories.a_risky_withdrawal()) == [Bank.FraudScore{1n, 60000}] : +List<Bank.Call>}

law a_risky_withdrawal.frozen:
  {Bank.account(Stories.found_risky(), 1n)
    == Account.Open{1n, 30000, True{}, 0, 60000} : Account.AccountState}

law a_risky_withdrawal.refused:
  {Bank.ask_account(Stories.found_risky(), 1n, Stories.sam(), Account.WithdrawMoney{10})
    == Domain.Reject{Account.Frozen{}} : Account.Decided()}

# STORY: split withdrawals that cross the daily threshold are reviewed.
law split_withdrawals:
  {Bank.calls_of(Stories.split_withdrawals()) == [Bank.FraudScore{1n, 60000}] : +List<Bank.Call>}

# STORY: the account is closed while the fraud check is pending.
law closed_while_checked.events:
  {Views.account_events(Bank.log_of(Stories.closed_while_checked()), 1n)
    == [Account.AccountOpened{1n}, Account.MoneyDeposited{60000, 60000},
        Account.MoneyWithdrawn{60000, 0}, Account.AccountClosed{}]
    : +List<Account.AccountEvent>}

law closed_while_checked.summary:
  {Views.summary(Bank.log_of(Stories.closed_while_checked()), 1n)
    == Views.Summary{True{}, 1n, 0, False{}, True{}} : Views.Summary}

# STORY: a transfer completes: the saga drives both accounts.
law a_transfer.source:
  {Bank.account(Stories.a_transfer(), 1n)
    == Account.Open{1n, 60, False{}, 0, 0} : Account.AccountState}

law a_transfer.destination:
  {Bank.account(Stories.a_transfer(), 2n)
    == Account.Open{2n, 40, False{}, 0, 0} : Account.AccountState}

law a_transfer.transfer:
  {Views.transfer_events(Bank.log_of(Stories.a_transfer()), 1n)
    == [Transfer.TransferRequested{Transfer.Details{1n, 2n, 40, Stories.sam()}, False{}},
        Transfer.TransferCompleted{}] : +List<Transfer.TransferEvent>}

law a_transfer.saga:
  {Bank.saga(Stories.a_transfer(), 1n) == Some{Bank.Finished{}} : Maybe<&2, Bank.Run>}

law a_transfer.status:
  {Views.transfer_status(Stories.a_transfer(), 1n) == Views.Completed{} : Views.Progress}

law a_transfer.shown_on_both:
  {(Views.moved(Bank.log_of(Stories.a_transfer()), 1n),
    Views.moved(Bank.log_of(Stories.a_transfer()), 2n))
    == ([Views.Moved{1n, 40, False{}}], [Views.Moved{1n, 40, True{}}])
    : +List<Views.Moved> & +List<Views.Moved>}

# STORY: a customer can't move money out of someone else's account.
law someone_elses_money.account:
  {Bank.account(Stories.someone_elses_money(), 1n)
    == Account.Open{1n, 100, False{}, 0, 0} : Account.AccountState}

law someone_elses_money.transfer:
  {Bank.transfer(Stories.someone_elses_money(), 1n)
    == Transfer.Failed{Transfer.NotYourAccount{}} : Transfer.TransferState}

# STORY: a large transfer waits for a support agent's approval.
law a_large_transfer.waits:
  {(Bank.saga(Stories.a_large_transfer(), 1n), Bank.account(Stories.a_large_transfer(), 1n))
    == (Some{Bank.WaitingForApproval{}}, Account.Open{1n, 50000, False{}, 0, 0})
    : Maybe<&2, Bank.Run> & Account.AccountState}

law a_large_transfer.customers_cannot_approve:
  {Bank.ask_transfer(Stories.a_large_transfer(), 1n, Stories.sam(), Transfer.ApproveTransfer{})
    == Domain.Reject{Transfer.NotPermitted{}} : Transfer.Decided()}

law a_large_transfer.approved:
  {(Bank.transfer(Stories.approved(), 1n),
    (Bank.account(Stories.approved(), 1n), Bank.account(Stories.approved(), 2n)))
    == (Transfer.Completed{},
       (Account.Open{1n, 30000, False{}, 0, 0}, Account.Open{2n, 20000, False{}, 0, 0}))
    : Transfer.TransferState & (Account.AccountState & Account.AccountState)}

# STORY: an unapproved transfer expires when its approval window closes.
law an_unapproved_transfer_expires:
  {(Bank.transfer(Stories.expired(), 1n), Bank.account(Stories.expired(), 1n))
    == (Transfer.Failed{Transfer.NotApprovedInTime{}}, Account.Open{1n, 50000, False{}, 0, 0})
    : Transfer.TransferState & Account.AccountState}

law an_unapproved_transfer_expires.too_late:
  {Bank.ask_transfer(Stories.expired(), 1n, Stories.support(), Transfer.ApproveTransfer{})
    == Domain.Reject{Transfer.NotAwaitingApproval{}} : Transfer.Decided()}

# STORY: a transfer to a closed account is compensated.
law to_a_closed_account.refunded:
  {Views.account_events(Bank.log_of(Stories.to_a_closed_account()), 1n)
    == [Account.AccountOpened{1n}, Account.MoneyDeposited{100, 100},
        Account.TransferDebited{1n, 40, 60}, Account.TransferRefunded{1n, 40, 100}]
    : +List<Account.AccountEvent>}

law to_a_closed_account.failed:
  {(Bank.transfer(Stories.to_a_closed_account(), 1n), Bank.saga(Stories.to_a_closed_account(), 1n))
    == (Transfer.Failed{Transfer.DestinationNotOpen{}},
        Some{Bank.FailedBecause{Transfer.DestinationNotOpen{}}})
    : Transfer.TransferState & Maybe<&2, Bank.Run>}

# STORY: the destination closes between the saga's debit and its credit, so
# the debit is refunded.
law closed_between_two_steps:
  {(Bank.account(Stories.closed_between_two_steps(), 1n),
    Bank.transfer(Stories.closed_between_two_steps(), 1n))
    == (Account.Open{1n, 100, False{}, 0, 0}, Transfer.Failed{Transfer.DestinationNotOpen{}})
    : Account.AccountState & Transfer.TransferState}

# STORY: a request delivered three times moves the money once.
law requested_three_times:
  {(Bank.account(Stories.requested_three_times(), 1n),
    Bank.account(Stories.requested_three_times(), 2n))
    == (Account.Open{1n, 60, False{}, 0, 0}, Account.Open{2n, 40, False{}, 0, 0})
    : Account.AccountState & Account.AccountState}

# STORY: a settlement on a closed account can't be rejected, so it is refunded.
law a_settlement_on_a_closed_account:
  {Bank.calls_of(Stories.a_settlement_on_a_closed_account()) == [Bank.Refund{9n, 500}]
    : +List<Bank.Call>}

# STORY: only agents reassign accounts, and the dashboards re-key.
law reassigning.customers_cannot:
  {Bank.ask_account(Stories.sams_account(100), 1n, Stories.sam(), Account.ChangeOwner{2n})
    == Domain.Reject{Account.NotPermitted{}} : Account.Decided()}

law reassigning.dashboards:
  {(Views.dashboard([1n], Bank.log_of(Stories.reassigned()), 1n),
    Views.dashboard([1n], Bank.log_of(Stories.reassigned()), 2n))
    == ([], [Views.Holding{1n, 100}]) : +List<Views.Holding> & +List<Views.Holding>}

law reassigning.activity:
  {Views.read_activity(Stories.support(), Bank.log_of(Stories.reassigned()), 1n)
    == Views.Allowed{[Account.OwnerChanged{1n, 2n}]} : Views.Read<+List<Account.AccountEvent>>}

# STORY: the ledger is as private as the account.
law the_ledger_is_private.owner:
  {Views.account_ledger(Stories.sam(), Bank.log_of(Stories.withdrawing()), 1n)
    == Views.Allowed{[Views.Line{Views.Deposit{}, 100, 100},
         Views.Line{Views.Withdrawal{}, 30, 70}]} : Views.Read<+List<Views.Line>>}

law the_ledger_is_private.another_customer:
  {Views.account_ledger(Stories.alex(), Bank.log_of(Stories.withdrawing()), 1n)
    == Views.Forbidden{} : Views.Read<+List<Views.Line>>}

# STORY: the AccountCards projection appends a card on every balance change.
law the_account_card:
  {Views.cards(Bank.log_of(Stories.withdrawing()), 1n)
    == [Views.Card{1n, 100, False{}}, Views.Card{1n, 70, False{}}] : +List<Views.Card>}
