# A search for the sequence of moves that breaks a rule. Where a proof says a
# rule holds for ever, this says it holds in every sequence tried, and when it
# does not, it gives the sequence.
#
#   bend Search.bend
#
# checks the rules about a settled bank in every sequence of up to four of the
# moves below, and shows the shortest sequence that breaks a rule that is false.

import Base
import ./Types.bend as T
import ./Account.bend as Account
import ./Transfer.bend as Transfer
import ./Customer.bend as Customer
import ./Bank.bend as Bank
import ./Views.bend as Views
import ./Stories.bend as Stories

# The moves a sequence is made of: what callers do, a fault, and the clock.
def moves() -> +List<Bank.Move>:
  [Bank.Register{Stories.sam(), Customer.RegisterCustomer{1n, 7n}},
   Bank.Register{Stories.alex(), Customer.RegisterCustomer{2n, 8n}},
   Bank.ToAccount{101n, Stories.sam(), Account.DepositMoney{30000}},
   Bank.ToTransfer{1n, Stories.sam(), Transfer.RequestTransfer{101n, 102n, 100}},
   Bank.ToTransfer{2n, Stories.sam(), Transfer.RequestTransfer{101n, 102n, 20000}},
   Bank.ToTransfer{2n, Stories.support(), Transfer.ApproveTransfer{}},
   Bank.ToAccount{102n, Stories.alex(), Account.CloseAccount{}},
   Bank.Redeliver{3n},
   Bank.Pass{86400}]

# Rules about a settled bank
# ==========================

def taken(events: +List<Account.AccountEvent>) -> U32:
  match events:
    case Nil{}:
      0
    case Account.TransferDebited{t, amount, after} <> rest:
      U32.add(amount, taken(rest))
    case _ <> rest:
      taken(rest)

def given(events: +List<Account.AccountEvent>) -> U32:
  match events:
    case Nil{}:
      0
    case Account.TransferCredited{t, amount, after} <> rest:
      U32.add(amount, given(rest))
    case Account.TransferRefunded{t, amount, after} <> rest:
      U32.add(amount, given(rest))
    case Account.RefundStranded{t, amount} <> rest:
      U32.add(amount, given(rest))
    case _ <> rest:
      given(rest)

# RULE: every cent a transfer takes out of an account is paid into another,
# paid back, or recorded as stranded.
def transfers_lose_no_money(+world: Bank.World()) -> Bool:
  U32.is_eq(
    U32.add(taken(Views.account_events(Bank.log_of(world), 101n)),
      taken(Views.account_events(Bank.log_of(world), 102n))),
    U32.add(given(Views.account_events(Bank.log_of(world), 101n)),
      given(Views.account_events(Bank.log_of(world), 102n))))

def is_pending(state: Transfer.TransferState) -> Bool:
  match state:
    case Transfer.Pending{details}:
      True{}
    case _:
      False{}

# RULE: a transfer that may run has run: it completed or it failed.
def no_transfer_left_pending(+world: Bank.World()) -> Bool:
  Bool.not(is_pending(Bank.transfer(world, 1n)) || is_pending(Bank.transfer(world, 2n)))

def has_ended(state: Transfer.TransferState) -> Bool:
  match state:
    case Transfer.Completed{}:
      True{}
    case Transfer.Failed{reason}:
      True{}
    case Transfer.New{}:
      True{}
    case _:
      False{}

def all_ended(+world: Bank.World()) -> Bool:
  has_ended(Bank.transfer(world, 1n)) && has_ended(Bank.transfer(world, 2n))

# RULE (eventually): once the approval window has closed, every transfer that
# was asked for has ended.
def every_transfer_ends(+world: Bank.World()) -> Bool:
  all_ended(Bank.play(world, Bank.Pass{86400}))

def is_waiting(state: Transfer.TransferState) -> Bool:
  match state:
    case Transfer.AwaitingApproval{details}:
      True{}
    case _:
      False{}

# A rule that is false: no transfer ever waits for approval.
def no_transfer_ever_waits(+world: Bank.World()) -> Bool:
  Bool.not(is_waiting(Bank.transfer(world, 1n)) || is_waiting(Bank.transfer(world, 2n)))

def is_completed(state: Transfer.TransferState) -> Bool:
  match state:
    case Transfer.Completed{}:
      True{}
    case _:
      False{}

# Another rule that is false: no transfer ever completes.
def no_transfer_ever_completes(+world: Bank.World()) -> Bool:
  Bool.not(is_completed(Bank.transfer(world, 1n)))

# The search
# ==========

def found(holds: Bool, deeper: Maybe<&2, +List<Nat>>, +index: Nat, sibling: Maybe<&2, +List<Nat>>)
  -> Maybe<&2, +List<Nat>>:
  match holds deeper:
    case False{} _:
      Some{[index]}
    case True{} Some{path}:
      Some{index <> path}
    case True{} None{}:
      sibling

# The first sequence of at most `depth` moves after which the rule fails, by
# where each move is in `all`. It tries the moves in `rest`, from `index` on.
def breaks(
  ~rule: @+w: Bank.World() -> Bool, depth: Nat, +all: +List<Bank.Move>, rest: +List<Bank.Move>,
  +index: Nat, +world: Bank.World()
) -> Maybe<&2, +List<Nat>>:
  match depth rest:
    case 0n _:
      None{}
    case 1n+d Nil{}:
      None{}
    case 1n+d +move <> more:
      +below = d
      found(rule(Bank.play(world, move)),
        breaks(~rule, below, all, all, 0n, Bank.play(world, move)),
        index,
        breaks(~rule, 1n+below, all, more, 1n+index, world))

def shortest.or(here: Maybe<&2, +List<Nat>>, deeper: Maybe<&2, +List<Nat>>)
  -> Maybe<&2, +List<Nat>>:
  match here:
    case Some{path}:
      Some{path}
    case None{}:
      deeper

# The shortest such sequence: the search runs at each depth up to the limit.
def shortest(~rule: @+w: Bank.World() -> Bool, limit: Nat, +depth: Nat, +all: +List<Bank.Move>)
  -> Maybe<&2, +List<Nat>>:
  match limit:
    case 0n:
      None{}
    case 1n+l:
      shortest.or(breaks(~rule, depth, all, all, 0n, Bank.start()),
        shortest(~rule, l, 1n+depth, all))

def show_path(path: +List<Nat>) -> String:
  match path:
    case Nil{}:
      ""
    case i <> rest:
      Nat.show(i) ++ " " ++ show_path(rest)

def verdict(name: String, result: Maybe<&2, +List<Nat>>) -> String:
  match result:
    case None{}:
      "holds in every sequence tried: " ++ name
    case Some{path}:
      "BROKEN by moves " ++ show_path(path) ++ ": " ++ name

def main() -> IO(Unit):
  do IO<Unit>:
    IO.print(verdict("transfers lose no money",
      shortest(~transfers_lose_no_money, 4n, 1n, moves())))
    IO.print(verdict("no transfer is left pending",
      shortest(~no_transfer_left_pending, 4n, 1n, moves())))
    IO.print(verdict("every transfer ends once the window closes",
      shortest(~every_transfer_ends, 4n, 1n, moves())))
    IO.print(verdict("no transfer ever waits for approval",
      shortest(~no_transfer_ever_waits, 4n, 1n, moves())))
    IO.print(verdict("no transfer ever completes",
      shortest(~no_transfer_ever_completes, 4n, 1n, moves())))
