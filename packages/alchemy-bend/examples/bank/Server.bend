# The bank over HTTP, kept in a journal file so it is where it was after a
# restart.
#
#   bend Server.bend -o build/bank && ./build/bank
#
# A request's path says who asks and what for:
#
#   /c/1/register/7                    customer 1 registers under username 7
#   /c/1/account/101/deposit/5000      deposit, withdraw, close, freeze, owner/N
#   /c/1/transfer/1/request/101/102/40 ask for a transfer; /a/7/transfer/1/approve
#   /c/1/account/101/summary           summary, statement, card
#   /c/1/customer/1/dashboard          /c/1/transfer/1/status
#   /pass/86400                        time passes, beyond the wall clock
#   /app/c/1                           customer 1's page; /app/a/7 an agent's
#
# Every request that changes the bank is written to the journal before it is
# applied, and the journal is replayed at the start.

import Base
import ../../Domain.bend as Domain
import ./Types.bend as T
import ./Account.bend as Account
import ./Transfer.bend as Transfer
import ./Customer.bend as Customer
import ./Bank.bend as Bank
import ./Views.bend as Views
import ./Api.bend as Api

# Reading a path
# ==============

type Part is Data:
  WC{}
  WA{}
  WAccount{}
  WTransfer{}
  WCustomer{}
  WRegister{}
  WDeposit{}
  WWithdraw{}
  WFreeze{}
  WClose{}
  WOwner{}
  WRequest{}
  WApprove{}
  WSummary{}
  WStatement{}
  WCard{}
  WDashboard{}
  WStatus{}
  WPass{}
  WApp{}
  WVersion{}
  WAnswer{}
  WFraud{}
  WRefund{}
  WOther{}

# This word, when the text is it; otherwise whatever else it turns out to be.
def word.is(same: Bool, this: Part, otherwise: Part) -> Part:
  match same:
    case True{}:
      this
    case False{}:
      otherwise

def word(+s: String) -> Part:
  word.is(String.eq(s, "c"), WC{},
    word.is(String.eq(s, "a"), WA{},
    word.is(String.eq(s, "account"), WAccount{},
    word.is(String.eq(s, "transfer"), WTransfer{},
    word.is(String.eq(s, "customer"), WCustomer{},
    word.is(String.eq(s, "register"), WRegister{},
    word.is(String.eq(s, "deposit"), WDeposit{},
    word.is(String.eq(s, "withdraw"), WWithdraw{},
    word.is(String.eq(s, "freeze"), WFreeze{},
    word.is(String.eq(s, "close"), WClose{},
    word.is(String.eq(s, "owner"), WOwner{},
    word.is(String.eq(s, "request"), WRequest{},
    word.is(String.eq(s, "approve"), WApprove{},
    word.is(String.eq(s, "summary"), WSummary{},
    word.is(String.eq(s, "statement"), WStatement{},
    word.is(String.eq(s, "card"), WCard{},
    word.is(String.eq(s, "dashboard"), WDashboard{},
    word.is(String.eq(s, "status"), WStatus{},
    word.is(String.eq(s, "pass"), WPass{},
    word.is(String.eq(s, "app"), WApp{},
    word.is(String.eq(s, "version"), WVersion{},
    word.is(String.eq(s, "answer"), WAnswer{},
    word.is(String.eq(s, "fraud"), WFraud{},
    word.is(String.eq(s, "refund"), WRefund{},
    WOther{}))))))))))))))))))))))))

# A part of a path: a number, or a word.
type Token is Data:
  N{value: Nat}
  W{word: Part}

def token.of(number: Maybe<&2, Nat>, word: Part) -> Token:
  match number:
    case Some{n}:
      N{n}
    case None{}:
      W{word}

def token(+s: String) -> Token:
  token.of(Nat.read(s), word(s))

def tokens.keep(empty: Bool, +part: String, rest: +List<Token>) -> +List<Token>:
  match empty:
    case True{}:
      rest
    case False{}:
      token(part) <> rest

def tokens(parts: List<&2, String>) -> +List<Token>:
  match parts:
    case Nil{}:
      []
    case +part <> rest:
      tokens.keep(String.is_empty(part), part, tokens(rest))

# What a request asks for.
type Asked is Data:
  Play{move: Bank.Move}
  Summary{actor: T.Actor, account: Nat}
  Statement{actor: T.Actor, account: Nat}
  Card{actor: T.Actor, account: Nat}
  Dashboard{actor: T.Actor, customer: Nat}
  Status{transfer: Nat}
  Page{}
  # How much has been recorded: a page that watches this stays live.
  Version{}
  Unknown{}
  # The same, answered with the asker's page: /app/c/1, /app/c/1/account/101/deposit/5000.
  Viewing{actor: T.Actor, who: Nat, asked: Asked}

def route.for(+actor: T.Actor, +who: Nat, rest: +List<Token>) -> Asked:
  match rest:
    case W{WRegister{}} <> N{username} <> Nil{}:
      Play{Bank.Register{actor, Customer.RegisterCustomer{who, username}}}
    case W{WAccount{}} <> N{id} <> W{WDeposit{}} <> N{amount} <> Nil{}:
      Play{Bank.ToAccount{id, actor, Account.DepositMoney{U32.from_nat(amount)}}}
    case W{WAccount{}} <> N{id} <> W{WWithdraw{}} <> N{amount} <> Nil{}:
      Play{Bank.ToAccount{id, actor, Account.WithdrawMoney{U32.from_nat(amount)}}}
    case W{WAccount{}} <> N{id} <> W{WClose{}} <> Nil{}:
      Play{Bank.ToAccount{id, actor, Account.CloseAccount{}}}
    case W{WAccount{}} <> N{id} <> W{WFreeze{}} <> Nil{}:
      Play{Bank.ToAccount{id, actor, Account.FreezeAccount{}}}
    case W{WAccount{}} <> N{id} <> W{WOwner{}} <> N{to} <> Nil{}:
      Play{Bank.ToAccount{id, actor, Account.ChangeOwner{to}}}
    case W{WAccount{}} <> N{id} <> W{WSummary{}} <> Nil{}:
      Summary{actor, id}
    case W{WAccount{}} <> N{id} <> W{WStatement{}} <> Nil{}:
      Statement{actor, id}
    case W{WAccount{}} <> N{id} <> W{WCard{}} <> Nil{}:
      Card{actor, id}
    case W{WCustomer{}} <> N{id} <> W{WDashboard{}} <> Nil{}:
      Dashboard{actor, id}
    case W{WTransfer{}} <> N{id} <> W{WRequest{}} <> N{source} <> N{destination} <> N{amount} <> Nil{}:
      Play{Bank.ToTransfer{id, actor,
        Transfer.RequestTransfer{source, destination, U32.from_nat(amount)}}}
    case W{WTransfer{}} <> N{id} <> W{WApprove{}} <> Nil{}:
      Play{Bank.ToTransfer{id, actor, Transfer.ApproveTransfer{}}}
    case W{WTransfer{}} <> N{id} <> W{WStatus{}} <> Nil{}:
      Status{id}
    case _:
      Unknown{}

def route(path: +List<Token>) -> Asked:
  match path:
    case Nil{}:
      Page{}
    case W{WC{}} <> N{+id} <> rest:
      route.for(T.ByCustomer{id}, id, rest)
    case W{WA{}} <> N{+id} <> rest:
      route.for(T.ByAgent{id}, id, rest)
    case W{WPass{}} <> N{seconds} <> Nil{}:
      Play{Bank.Pass{U32.from_nat(seconds)}}
    case W{WVersion{}} <> Nil{}:
      Version{}
    case W{WApp{}} <> W{WC{}} <> N{+id} <> rest:
      Viewing{T.ByCustomer{id}, id, route.for(T.ByCustomer{id}, id, rest)}
    case W{WApp{}} <> W{WA{}} <> N{+id} <> rest:
      Viewing{T.ByAgent{id}, id, route.for(T.ByAgent{id}, id, rest)}
    case _:
      Unknown{}

# What a path asks for.
def asked(path: String) -> Asked:
  route(tokens(String.split(path, '/')))

# Answering
# =========

def show_bool(b: Bool) -> String:
  match b:
    case True{}:
      "true"
    case False{}:
      "false"

def show_account_rejection(why: Account.AccountRejection) -> String:
  match why:
    case Account.AlreadyOpen{}:
      "AlreadyOpen"
    case Account.NotOpen{}:
      "NotOpen"
    case Account.NotOwner{}:
      "NotOwner"
    case Account.NotPermitted{}:
      "NotPermitted"
    case Account.Frozen{}:
      "Frozen"
    case Account.InsufficientFunds{balance, requested}:
      "InsufficientFunds balance=" ++ U32.show(balance) ++ " requested=" ++ U32.show(requested)
    case Account.DailyLimitExceeded{remaining}:
      "DailyLimitExceeded remaining=" ++ U32.show(remaining)
    case Account.BalanceNotZero{balance}:
      "BalanceNotZero balance=" ++ U32.show(balance)

def show_transfer_rejection(why: Transfer.TransferRejection) -> String:
  match why:
    case Transfer.AlreadyRequested{}:
      "AlreadyRequested"
    case Transfer.SameAccount{}:
      "SameAccount"
    case Transfer.NotPermitted{}:
      "NotPermitted"
    case Transfer.NotAwaitingApproval{}:
      "NotAwaitingApproval"

def show_registration_rejection(why: Customer.RegistrationRejection) -> String:
  match why:
    case Customer.AlreadyRegistered{}:
      "AlreadyRegistered"
    case Customer.NotTheCustomer{}:
      "NotTheCustomer"
    case Customer.UsernameTaken{}:
      "UsernameTaken"

# A response: whether the request was accepted, and what to say.
type Answer is Data:
  Answer{status: String, body: String}

def ok(body: String) -> Answer:
  Answer{"200 OK", body}

def rejected(why: String) -> Answer:
  Answer{"409 Conflict", "{\"rejected\":\"" ++ why ++ "\"}"}

def forbidden() -> Answer:
  Answer{"403 Forbidden", "{\"error\":\"forbidden\"}"}

def account_answer(decided: Account.Decided()) -> Answer:
  match decided:
    case Domain.Reject{why}:
      rejected(show_account_rejection(why))
    case Domain.Record{events}:
      ok("{\"recorded\":" ++ Nat.show(List.length(&2, Account.AccountEvent, events)) ++ "}")

def transfer_answer(decided: Transfer.Decided()) -> Answer:
  match decided:
    case Domain.Reject{why}:
      rejected(show_transfer_rejection(why))
    case Domain.Record{events}:
      ok("{\"recorded\":" ++ Nat.show(List.length(&2, Transfer.TransferEvent, events)) ++ "}")

def registration_answer(registration: Customer.Registration) -> Answer:
  match registration:
    case Customer.Refused{why}:
      rejected(show_registration_rejection(why))
    case Customer.Accepted{on_customer, on_claim}:
      ok("{\"recorded\":2}")

# What the caller is told about a move, from the bank before it.
def told(+world: Bank.World(), move: Bank.Move) -> Answer:
  match move:
    case Bank.ToAccount{id, actor, command}:
      account_answer(Bank.ask_account(world, id, actor, command))
    case Bank.ToTransfer{id, actor, command}:
      transfer_answer(Bank.ask_transfer(world, id, actor, command))
    case Bank.Register{actor, command}:
      registration_answer(Bank.ask_register(world, actor, command))
    case _:
      ok("{}")

def show_summary(read: Views.Read<Views.Summary>) -> Answer:
  match read:
    case Views.Forbidden{}:
      forbidden()
    case Views.Allowed{Views.Summary{opened, customer, balance, frozen, closed}}:
      ok("{\"opened\":" ++ show_bool(opened) ++ ",\"customer\":" ++ Nat.show(customer)
        ++ ",\"balance\":" ++ U32.show(balance) ++ ",\"frozen\":" ++ show_bool(frozen)
        ++ ",\"closed\":" ++ show_bool(closed) ++ "}")

def show_kind(kind: Views.LineKind) -> String:
  match kind:
    case Views.Deposit{}:
      "deposit"
    case Views.Withdrawal{}:
      "withdrawal"
    case Views.TransferIn{}:
      "transfer-in"
    case Views.TransferOut{}:
      "transfer-out"
    case Views.RefundIn{}:
      "refund"
    case Views.Settlement{}:
      "settlement"

def show_lines(lines: +List<Views.Line>) -> String:
  match lines:
    case Nil{}:
      ""
    case Views.Line{kind, amount, balance} <> rest:
      "{\"kind\":\"" ++ show_kind(kind) ++ "\",\"amount\":" ++ U32.show(amount)
        ++ ",\"balance\":" ++ U32.show(balance) ++ "}\n" ++ show_lines(rest)

def show_statement(read: Views.Read<+List<Views.Line>>) -> Answer:
  match read:
    case Views.Forbidden{}:
      forbidden()
    case Views.Allowed{lines}:
      ok(show_lines(lines))

def show_cards(cards: +List<Views.Card>) -> String:
  match cards:
    case Nil{}:
      ""
    case Views.Card{customer, balance, frozen} <> rest:
      "{\"customer\":" ++ Nat.show(customer) ++ ",\"balance\":" ++ U32.show(balance)
        ++ ",\"frozen\":" ++ show_bool(frozen) ++ "}\n" ++ show_cards(rest)

def guard_cards(may: Bool, cards: +List<Views.Card>) -> Answer:
  match may:
    case True{}:
      ok(show_cards(cards))
    case False{}:
      forbidden()

def show_holdings(holdings: +List<Views.Holding>) -> String:
  match holdings:
    case Nil{}:
      ""
    case Views.Holding{account, balance} <> rest:
      "{\"account\":" ++ Nat.show(account) ++ ",\"balance\":" ++ U32.show(balance) ++ "}\n"
        ++ show_holdings(rest)

def guard_holdings(may: Bool, holdings: +List<Views.Holding>) -> Answer:
  match may:
    case True{}:
      ok(show_holdings(holdings))
    case False{}:
      forbidden()

def show_progress(progress: Views.Progress) -> String:
  match progress:
    case Views.NotRequested{}:
      "not-requested"
    case Views.AwaitingApproval{}:
      "awaiting-approval"
    case Views.Pending{}:
      "pending"
    case Views.InFlight{}:
      "in-flight"
    case Views.Completed{}:
      "completed"
    case Views.Failed{reason}:
      "failed"

def page() -> String:
  "<!doctype html><meta charset=utf-8><title>Bank</title><h1>Bank</h1>"
    ++ "<p>As customer <input id=who value=1 size=3> account <input id=account value=101 size=5>"
    ++ " amount <input id=amount value=5000 size=7></p>"
    ++ "<p><button onclick=\"go('/c/1/register/7')\">Register 1</button>"
    ++ "<button onclick=\"go('/c/2/register/8')\">Register 2</button>"
    ++ "<button onclick=\"go(a()+'/deposit/'+amount.value)\">Deposit</button>"
    ++ "<button onclick=\"go(a()+'/withdraw/'+amount.value)\">Withdraw</button>"
    ++ "<button onclick=\"go('/c/'+who.value+'/transfer/'+Date.now()%100000+'/request/'+account.value+'/102/'+amount.value)\">Transfer to 102</button></p>"
    ++ "<h2>Answer</h2><pre id=answer></pre><h2>Summary</h2><pre id=summary></pre>"
    ++ "<h2>Statement</h2><pre id=statement></pre><script>"
    ++ "const a=()=>'/c/'+who.value+'/account/'+account.value;"
    ++ "async function show(){for(const n of['summary','statement'])"
    ++ "document.getElementById(n).textContent=await(await fetch(a()+'/'+n)).text()}"
    ++ "async function go(p){const r=await fetch(p);answer.textContent=r.status+' '+await r.text();show()}"
    ++ "show()</script>"

# Pages
# =====
#
# A page is a function of the bank and of who is looking, through the same
# guarded reads the server answers; each link on it sends a command.

def money.cents(cents: U32) -> String:
  U32.show(cents)

def link(href: String, label: String) -> String:
  "<a href=\"" ++ href ++ "\">" ++ label ++ "</a> "

def line_rows(lines: +List<Views.Line>) -> String:
  match lines:
    case Nil{}:
      ""
    case Views.Line{kind, amount, balance} <> rest:
      "<tr><td>" ++ show_kind(kind) ++ "</td><td>" ++ U32.show(amount) ++ "</td><td>"
        ++ U32.show(balance) ++ "</td></tr>" ++ line_rows(rest)

def direction(incoming: Bool) -> String:
  match incoming:
    case True{}:
      "in"
    case False{}:
      "out"

def moved_rows(moved: +List<Views.Moved>, +world: Bank.World()) -> String:
  match moved:
    case Nil{}:
      ""
    case Views.Moved{+transfer, amount, incoming} <> rest:
      "<tr><td>" ++ Nat.show(transfer) ++ "</td><td>" ++ direction(incoming) ++ "</td><td>"
        ++ U32.show(amount) ++ "</td><td>" ++ show_progress(Views.transfer_status(world, transfer))
        ++ "</td></tr>" ++ moved_rows(rest, world)

def account_part.shown(read: Views.Read<Views.Summary>, +base: String, +world: Bank.World(), +account: Nat)
  -> String:
  match read:
    case Views.Forbidden{}:
      "<p>You may not see this account.</p>"
    case Views.Allowed{Views.Summary{opened, customer, balance, frozen, closed}}:
      "<h2>Account " ++ Nat.show(account) ++ "</h2><p>Balance " ++ U32.show(balance)
        ++ " cents, frozen " ++ show_bool(frozen) ++ ", closed " ++ show_bool(closed) ++ "</p><p>"
        ++ link(base ++ "/account/" ++ Nat.show(account) ++ "/deposit/10000", "Deposit 10000")
        ++ link(base ++ "/account/" ++ Nat.show(account) ++ "/withdraw/2500", "Withdraw 2500")
        ++ link(base ++ "/transfer/" ++ U32.show(Bank.now_of(world)) ++ "/request/"
             ++ Nat.show(account) ++ "/102/4000", "Send 4000 to account 102")
        ++ link(base ++ "/transfer/" ++ U32.show(U32.add(Bank.now_of(world), 1)) ++ "/request/"
             ++ Nat.show(account) ++ "/102/20000", "Send 20000 to account 102")
        ++ "</p><table><tr><th>Statement</th><th>Amount</th><th>Balance</th></tr>"
        ++ line_rows(Views.statement(Bank.log_of(world), account)) ++ "</table>"
        ++ "<table><tr><th>Transfer</th><th>Direction</th><th>Amount</th><th>Status</th></tr>"
        ++ moved_rows(Views.moved(Bank.log_of(world), account), world) ++ "</table>"

def account_part(+actor: T.Actor, +base: String, +world: Bank.World(), +account: Nat) -> String:
  account_part.shown(Views.read_summary(actor, Bank.log_of(world), account), base, world, account)

def waiting.row(waits: Bool, +id: Nat, +base: String) -> String:
  match waits:
    case True{}:
      "<p>Transfer " ++ Nat.show(id) ++ " waits for approval. "
        ++ link(base ++ "/transfer/" ++ Nat.show(id) ++ "/approve", "Approve") ++ "</p>"
    case False{}:
      ""

def is_waiting(state: Transfer.TransferState) -> Bool:
  match state:
    case Transfer.AwaitingApproval{details}:
      True{}
    case _:
      False{}

# The transfers that wait for approval, each with a link to approve it.
def waiting(log: +List<Bank.Emitted>, +world: Bank.World(), +base: String) -> String:
  match log:
    case Nil{}:
      ""
    case Bank.FromTransfer{+id, Transfer.TransferRequested{details, needs}} <> rest:
      waiting.row(is_waiting(Bank.transfer(world, id)), id, base) ++ waiting(rest, world, base)
    case _ <> rest:
      waiting(rest, world, base)

def view.body(actor: T.Actor, +who: Nat, +base: String, +world: Bank.World()) -> String:
  match actor:
    case T.ByCustomer{id}:
      "<p>" ++ link(base ++ "/register/" ++ Nat.show(who), "Register") ++ link(base, "Refresh")
        ++ link("/app/a/7", "Look as a support agent") ++ "</p>"
        ++ account_part(T.ByCustomer{id}, base, world, Bank.main_account(who))
    case T.ByAgent{+id}:
      "<p>" ++ link(base, "Refresh") ++ link("/app/c/1", "Look as customer 1")
        ++ link("/app/c/2", "Look as customer 2") ++ "</p>"
        ++ waiting(Bank.log_of(world), world, base)
        ++ account_part(T.ByAgent{id}, base, world, 101n)
        ++ account_part(T.ByAgent{id}, base, world, 102n)
    case T.BySystem{id}:
      ""

def base_of(actor: T.Actor, who: Nat) -> String:
  match actor:
    case T.ByAgent{id}:
      "/app/a/" ++ Nat.show(who)
    case _:
      "/app/c/" ++ Nat.show(who)

# The page for whoever is looking, with what the last request answered.
def view(+actor: T.Actor, +who: Nat, note: String, +world: Bank.World()) -> String:
  "<!doctype html><meta charset=utf-8><title>Bank</title><style>body{font:15px system-ui;"
    ++ "max-width:46rem;margin:2rem auto}td,th{padding:.2rem .7rem;text-align:left}"
    ++ "a{margin-right:.6rem}</style><h1>Bank</h1><p>" ++ note ++ "</p>"
    ++ view.body(actor, who, base_of(actor, who), world)
    ++ "<script>let seen=null;setInterval(async()=>{const v=await(await fetch('/version')).text();"
    ++ "if(seen!==null&&v!==seen)location.replace('" ++ base_of(actor, who) ++ "');seen=v},1000)"
    ++ "</script>"

# Whether the Api offers the move to this actor: customers get the customer
# Api, and agents get both.
def offered.to(actor: T.Actor, customer: Bool, support: Bool) -> Bool:
  match actor:
    case T.ByCustomer{id}:
      customer
    case T.ByAgent{id}:
      customer || support
    case T.BySystem{id}:
      False{}

def offered(+move: Bank.Move) -> Bool:
  match move:
    case Bank.ToAccount{id, actor, command}:
      offered.to(actor, Api.customer_api(move), Api.support_api(move))
    case Bank.ToTransfer{id, actor, command}:
      offered.to(actor, Api.customer_api(move), Api.support_api(move))
    case Bank.Register{actor, command}:
      True{}
    case Bank.Pass{seconds}:
      True{}
    case _:
      False{}

# Outside systems
# ===============
#
# The server calls an outside system for each call the bank is waiting on, and
# writes what it answered to the journal ("answer/fraud/95"), so a replay
# never asks again.

# The call the bank has waited on longest, if it waits on one.
type Waiting is Data:
  NoCall{}
  AskFraud{account: Nat, total: U32}
  AskRefund{settlement: Nat, amount: U32}

def call_waiting.first(calls: +List<Bank.Call>) -> Waiting:
  match calls:
    case Bank.FraudScore{account, total} <> rest:
      AskFraud{account, total}
    case Bank.Refund{settlement, amount} <> rest:
      AskRefund{settlement, amount}
    case Nil{}:
      NoCall{}

def call_waiting(world: Bank.World()) -> Waiting:
  call_waiting.first(Bank.calls_of(world))

def stand_in.risk(risky: Bool) -> Nat:
  match risky:
    case True{}:
      95n
    case False{}:
      10n

# The stand-in for the fraud system: a day's outflow of 900.00 or more is risky.
def stand_in_risk(total: U32) -> Nat:
  stand_in.risk(U32.is_le(90000, total))

# An answer from outside, as a journal line says it.
def answer_move(tokens: +List<Token>) -> Maybe<&2, Bank.Move>:
  match tokens:
    case W{WAnswer{}} <> W{WFraud{}} <> N{risk} <> Nil{}:
      Some{Bank.AnswerFraud{risk}}
    case W{WAnswer{}} <> W{WRefund{}} <> Nil{}:
      Some{Bank.AnswerRefund{}}
    case _:
      None{}

# What a request leaves and answers: the bank after it, whether it is to be
# written to the journal, and the response.
type Handled is Data:
  Handled{world: Bank.World(), journal: Bool, answer: Answer}

def handle.play(+world: Bank.World(), +move: Bank.Move, may: Bool) -> Handled:
  match may:
    case True{}:
      Handled{Bank.play(world, move), True{}, told(world, move)}
    case False{}:
      Handled{world, False{}, forbidden()}

# The page, after whatever was asked for on it.
def handle.viewing(+actor: T.Actor, +who: Nat, handled: Handled) -> Handled:
  match handled:
    case Handled{+world, journal, Answer{status, body}}:
      Handled{world, journal, Answer{"200 OK", view(actor, who, body, world)}}

def handle(+world: Bank.World(), what: Asked) -> Handled:
  match what:
    case Play{+move}:
      handle.play(world, move, offered(move))
    case Summary{actor, account}:
      Handled{world, False{}, show_summary(Views.read_summary(actor, Bank.log_of(world), account))}
    case Statement{actor, account}:
      Handled{world, False{},
        show_statement(Views.account_ledger(actor, Bank.log_of(world), account))}
    case Card{actor, +account}:
      Handled{world, False{},
        guard_cards(Views.owned_by(actor, Views.summary(Bank.log_of(world), account)),
          Views.cards(Bank.log_of(world), account))}
    case Dashboard{actor, +customer}:
      Handled{world, False{},
        guard_holdings(T.may_act(actor, customer),
          Views.dashboard([Bank.main_account(customer)], Bank.log_of(world), customer))}
    case Status{transfer}:
      Handled{world, False{},
        ok("{\"status\":\"" ++ show_progress(Views.transfer_status(world, transfer)) ++ "\"}")}
    case Page{}:
      Handled{world, False{}, Answer{"200 OK", page()}}
    case Version{}:
      Handled{world, False{},
        ok(Nat.show(List.length(&2, Bank.Emitted, Bank.log_of(world))))}
    case Unknown{}:
      Handled{world, False{}, Answer{"404 Not Found", "{\"error\":\"no such route\"}"}}
    case Viewing{actor, who, Unknown{}}:
      Handled{world, False{}, Answer{"200 OK", view(actor, who, "", world)}}
    case Viewing{actor, who, inner}:
      handle.viewing(actor, who, handle(world, inner))

def replay.one(handled: Handled) -> Bank.World():
  match handled:
    case Handled{world, journal, answer}:
      world

def apply_line.go(+world: Bank.World(), +line: String, answer: Maybe<&2, Bank.Move>)
  -> Bank.World():
  match answer:
    case Some{move}:
      Bank.play(world, move)
    case None{}:
      replay.one(handle(world, asked(line)))

# The bank after one journal line: a request, or an answer from outside.
def apply_line(+world: Bank.World(), +line: String) -> Bank.World():
  apply_line.go(world, line, answer_move(tokens(String.split(line, '/'))))

# The bank a journal leaves: its lines, replayed in order.
def replay(lines: List<&2, String>, +world: Bank.World()) -> Bank.World():
  match lines:
    case Nil{}:
      world
    case +line <> rest:
      replay(rest, apply_line(world, line))

# Serving
# =======

# The wall clock, in seconds since 1970. Base has none, so this is an effect
# of the server's own.
def Clock.unix() -> IO(U32):
  import "./clock.c"
  import "./clock.js"

# The bank once the wall clock is taken into account: whether time moved, the
# journal line that says so, and the bank after it.
type Ticked is Data:
  Ticked{world: Bank.World(), moved: Bool, line: String}

def tick.go(moved: Bool, +world: Bank.World(), +by: U32) -> Ticked:
  match moved:
    case True{}:
      Ticked{Bank.play(world, Bank.Pass{by}), True{}, "/pass/" ++ U32.show(by)}
    case False{}:
      Ticked{world, False{}, ""}

def tick(+world: Bank.World(), +now: U32) -> Ticked:
  tick.go(U32.is_lt(Bank.now_of(world), now), world, U32.sub(now, Bank.now_of(world)))

def response(answer: Answer) -> String:
  match answer:
    case Answer{status, body}:
      "HTTP/1.1 " ++ status ++ "\r\nContent-Type: text/html\r\nConnection: close\r\n\r\n" ++ body

def second(parts: List<&2, String>) -> String:
  match parts:
    case first <> path <> rest:
      path
    case _:
      "/"

# The path of a request, from its first line: "GET /path HTTP/1.1".
def path_of(request: String) -> String:
  second(String.split(request, ' '))

def journal_written(m: File & Result<&1, &1, U32 & String, Unit>) -> IO(Unit):
  (f, r) = m
  File.close(f)

def journal_append(path: String, line: String) -> IO(Unit):
  do IO<Unit>:
    f : File <- IO.try(File, File.open(path, "a"))
    w : File & Result<&1, &1, U32 & String, Unit> <- File.write(f, line ++ "\n")
    journal_written(w)

# Writes a request that changes the bank to the journal.
def keep(wrote: Bool, journal: String, path: String) -> IO(Unit):
  match wrote:
    case True{}:
      journal_append(journal, path)
    case False{}:
      IO.pure(Unit, Unit{})

def sent(m: Socket & Result<&1, &1, (U32 & String) & List<&2, U32>, Unit>) -> IO(Unit):
  (s, r) = m
  Socket.close(s)

def risk_of(ran: Result<&1, &1, U32 & String, U32 & (String & String)>, otherwise: Nat) -> Nat:
  match ran:
    case Done{(status, (out, err))}:
      Maybe.default(&2, Nat, Nat.read(String.trim(out)), otherwise)
    case Fail{e}:
      otherwise

# FraudCheck.score: asks the service at FRAUD_URL for a risk out of 100, with
# curl. With no FRAUD_URL, a stand-in answers.
def fraud_score(set: Result<&1, &1, U32 & String, String>, account: Nat, +total: U32) -> IO(Nat):
  match set:
    case Fail{e}:
      IO.pure(Nat, stand_in_risk(total))
    case Done{url}:
      do IO<Nat>:
        ran : Result<&1, &1, U32 & String, U32 & (String & String)> <- Process.run("curl",
          ["-fsS", "--max-time", "10",
            url ++ "?account=" ++ Nat.show(account) ++ "&amount=" ++ U32.show(total)],
          "", 65536, 15000)
        return risk_of(ran, stand_in_risk(total))

def refunded(ran: Result<&1, &1, U32 & String, U32 & (String & String)>) -> Unit:
  Unit{}

# Payments.refund: asks the service at PAYMENTS_URL to refund, with curl.
def refund(set: Result<&1, &1, U32 & String, String>, settlement: Nat, amount: U32) -> IO(Unit):
  match set:
    case Fail{e}:
      IO.pure(Unit, Unit{})
    case Done{url}:
      do IO<Unit>:
        ran : Result<&1, &1, U32 & String, U32 & (String & String)> <- Process.run("curl",
          ["-fsS", "--max-time", "10",
            url ++ "?settlement=" ++ Nat.show(settlement) ++ "&amount=" ++ U32.show(amount)],
          "", 65536, 15000)
        return refunded(ran)

# Calls the outside systems the bank is waiting on, until none is left. Each
# answer is written to the journal before the bank takes it.
def call_outside(fuel: Nat, +journal: String, +world: Bank.World(), next: Waiting)
  -> IO(Bank.World()):
  match fuel next:
    case 0n _:
      IO.pure(Bank.World(), world)
    case 1n+p NoCall{}:
      IO.pure(Bank.World(), world)
    case 1n+p AskFraud{account, total}:
      do IO<Bank.World()>:
        set : Result<&1, &1, U32 & String, String> <- IO.get_env("FRAUD_URL")
        +risk : Nat <- fraud_score(set, account, total)
        journal_append(journal, "answer/fraud/" ++ Nat.show(risk))
        call_outside(p, journal, Bank.play(world, Bank.AnswerFraud{risk}),
          call_waiting(Bank.play(world, Bank.AnswerFraud{risk})))
    case 1n+p AskRefund{settlement, amount}:
      do IO<Bank.World()>:
        set : Result<&1, &1, U32 & String, String> <- IO.get_env("PAYMENTS_URL")
        refund(set, settlement, amount)
        journal_append(journal, "answer/refund")
        call_outside(p, journal, Bank.play(world, Bank.AnswerRefund{}),
          call_waiting(Bank.play(world, Bank.AnswerRefund{})))

def finish(s: Socket, +journal: String, path: String, handled: Handled) -> IO(Bank.World()):
  match handled:
    case Handled{+world, wrote, answer}:
      do IO<Bank.World()>:
        keep(wrote, journal, path)
        after : Bank.World() <- call_outside(16n, journal, world, call_waiting(world))
        m : Socket & Result<&1, &1, (U32 & String) & List<&2, U32>, Unit> <- TCP.send(s, response(answer))
        sent(m)
        return after

def respond(s: Socket, +journal: String, +path: String, ticked: Ticked) -> IO(Bank.World()):
  match ticked:
    case Ticked{+world, moved, line}:
      do IO<Bank.World()>:
        keep(moved, journal, line)
        finish(s, journal, path, handle(world, asked(path)))

def unread(s: Socket, world: Bank.World()) -> IO(Bank.World()):
  do IO<Bank.World()>:
    Socket.close(s)
    return world

def reply(
  m: Socket & Result<&1, &1, U32 & String, Maybe<&1, String>>, +world: Bank.World(), journal: String,
  now: U32
) -> IO(Bank.World()):
  (s, r) = m
  match r:
    case Done{Some{request}}:
      respond(s, journal, path_of(request), tick(world, now))
    case Done{None{}}:
      unread(s, world)
    case Fail{e}:
      unread(s, world)

def talk(s: Socket, +world: Bank.World(), journal: String) -> IO(Bank.World()):
  do IO<Bank.World()>:
    read : Socket & Result<&1, &1, U32 & String, Maybe<&1, String>> <- TCP.recv(s, 8192)
    now : U32 <- Clock.unix()
    reply(read, world, journal, now)

# Handles one connection, then goes on with the listener and the bank it left.
def conn(
  m: Listener & Result<&1, &1, U32 & String, Socket>, +world: Bank.World(), journal: String,
  go_on: Listener -> @+w: Bank.World() -> IO(Unit)
) -> IO(Unit):
  (l, r) = m
  do IO<Unit>:
    s : Socket <- IO.pass(Socket, r)
    w : Bank.World() <- talk(s, world, journal)
    go_on(l, w)

# One request at a time, each from the bank the last one left.
def serve(fuel: Nat, l: Listener, +world: Bank.World(), +journal: String) -> IO(Unit):
  match fuel:
    case 0n:
      Listener.close(l)
    case 1n+p:
      do IO<Unit>:
        m : Listener & Result<&1, &1, U32 & String, Socket> <- TCP.accept(l)
        conn(m, world, journal, l2 => +w2 => serve(p, l2, w2, journal))

def load.done(m: File & Result<&1, &1, U32 & String, String>) -> IO(Bank.World()):
  (f, r) = m
  match r:
    case Done{text}:
      do IO<Bank.World()>:
        File.close(f)
        return replay(String.lines(text), Bank.start())
    case Fail{e}:
      do IO<Bank.World()>:
        File.close(f)
        return Bank.start()

def load.read(opened: Result<&1, &1, U32 & String, File>) -> IO(Bank.World()):
  match opened:
    case Fail{e}:
      IO.pure(Bank.World(), Bank.start())
    case Done{f}:
      do IO<Bank.World()>:
        m : File & Result<&1, &1, U32 & String, String> <- File.read(f, 16777216)
        load.done(m)

# The bank the journal leaves, or a new one when there is no journal.
def load(journal: String) -> IO(Bank.World()):
  do IO<Bank.World()>:
    opened : Result<&1, &1, U32 & String, File> <- File.open(journal, "r")
    load.read(opened)

# Where to listen: BANK_HOST, or this machine only.
def host_of(set: Result<&1, &1, U32 & String, String>) -> String:
  match set:
    case Done{host}:
      host
    case Fail{e}:
      "127.0.0.1"

def main() -> IO(Unit):
  do IO<Unit>:
    world : Bank.World() <- load("bank.journal")
    set : Result<&1, &1, U32 & String, String> <- IO.get_env("BANK_HOST")
    l : Listener <- IO.try(Listener, TCP.listen(host_of(set), 8788))
    IO.print("Bank: serving on port 8788, kept in bank.journal")
    serve(4294967295n, l, world, "bank.journal")
