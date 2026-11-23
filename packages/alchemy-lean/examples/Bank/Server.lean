import Alchemy
import Bank.Model
import Bank.Api

/-!
The bank over HTTP. `lake exe bank` serves it, and keeps it in a journal file,
so it is where it was after a restart.

- `POST /commands` sends a command: `{"as": "customer:c-1", "type": "DepositMoney", ...}`.
- `GET /accounts/:id/summary`, `/statement`, `/ledger`, `/card`, `/customers/:id/dashboard` and
  `/transfers/:id` read, as whoever `?as=` says.
- `GET /` is a page that does both.
-/

open Alchemy
open Lean (Json)

namespace Bank

/-- Who a request is from: `customer:c-1`, `agent:support-7`. -/
def actorOf (text : String) : Option Actor :=
  match text.splitOn ":" with
  | ["customer", id] => some (.customer id)
  | ["agent", id] => some (.agent id)
  | _ => none

def json (status : Nat) (body : Json) : Reply := { status, body := body.compress }

def refused (status : Nat) (why : String) : Reply := json status (Json.mkObj [("error", why)])

def field (body : Json) (name : String) : Option String := (body.getObjValAs? String name).toOption
def amount (body : Json) (name : String) : Option Nat := (body.getObjValAs? Nat name).toOption

/-- What the caller is told about a command: what it recorded, or why it was rejected. -/
def answered {Event Rejection : Type} [Repr Event] [Repr Rejection]
    (answer : Except Rejection (List Event)) (reply : Json := Json.null) : Reply :=
  match answer with
  | .ok events =>
    json 200 (Json.mkObj [("recorded", Json.arr (events.toArray.map fun e => reprStr e)),
      ("reply", reply)])
  | .error rejection => json 409 (Json.mkObj [("rejected", reprStr rejection)])

def toAccount (actor : Actor) (command : AccountCommand) : Routed Bank :=
  let send : Send BankAggregates := ⟨.account, actor, command⟩
  let offered := match actor with
    | .customer _ => CustomerApi.accepts send
    | _ => SupportApi.accepts send || CustomerApi.accepts send
  if offered then
    .move (.send send) fun before after =>
      let id := keyOfAccount command
      answered (decideAccount ⟨actor, before.now⟩ (before.state .account id) command)
        (match replyAccount (after.state .account id) command with
          | some balance => Json.mkObj [("balance", balance)]
          | none => Json.null)
  else .refuse (refused 403 "this Api does not offer that command")

def toTransfer (actor : Actor) (command : TransferCommand) : Routed Bank :=
  let send : Send BankAggregates := ⟨.transfer, actor, command⟩
  let offered := match actor with
    | .customer _ => CustomerApi.accepts send
    | _ => SupportApi.accepts send || CustomerApi.accepts send
  if offered then
    .move (.send send) fun before _ =>
      answered (decideTransfer ⟨actor, before.now⟩
        (before.state .transfer (Transfer.keyOf command)) command)
  else .refuse (refused 403 "this Api does not offer that command")

/-- What a request body asks for. -/
inductive Asked where
  | register (c : RegisterCustomer)
  | account (c : AccountCommand)
  | transfer (c : TransferCommand)

def asked (body : Json) : Option (Actor × Asked) := do
  let actor ← actorOf (← field body "as")
  let what ← match ← field body "type" with
    | "RegisterCustomer" =>
      pure (Asked.register ⟨← field body "customerId", ← field body "name", ← field body "username"⟩)
    | "DepositMoney" => pure (.account (.deposit ⟨← field body "accountId", ← amount body "amount"⟩))
    | "WithdrawMoney" => pure (.account (.withdraw ⟨← field body "accountId", ← amount body "amount"⟩))
    | "CloseAccount" => pure (.account (.close ⟨← field body "accountId"⟩))
    | "FreezeAccount" => pure (.account (.freeze ⟨← field body "accountId", ← field body "reason"⟩))
    | "ChangeOwner" =>
      pure (.account (.changeOwner ⟨← field body "accountId", ← field body "customerId"⟩))
    | "RequestTransfer" =>
      pure (.transfer (.request
        ⟨← field body "transferId", ← field body "from", ← field body "to", ← amount body "amount"⟩))
    | "ApproveTransfer" => pure (.transfer (.approve ⟨← field body "transferId"⟩))
    | _ => none
  pure (actor, what)

def command (actor : Actor) : Asked → Routed Bank
  | .register c =>
    .move (.decide Registration actor c) fun before _ =>
      match decideRegistration ⟨actor, before.now⟩ before.state c with
      | .ok _ => json 200 (Json.mkObj [("recorded", Json.arr #["customerRegistered", "usernameClaimed"])])
      | .error rejection => json 409 (Json.mkObj [("rejected", reprStr rejection)])
  | .account c => toAccount actor c
  | .transfer c => toTransfer actor c

/-- A read that a view, a stream or a query guards. -/
def guarded {α Rejection : Type} [Repr Rejection] (read : Except Rejection α) (show_ : α → Json) :
    Reply :=
  match read with
  | .ok value => json 200 (show_ value)
  | .error rejection => refused 403 (reprStr rejection)

def lineJson (line : StatementLine) : Json :=
  Json.mkObj [("kind", reprStr line.kind), ("amount", line.amount), ("balance", line.balance)]

def page : String := "<!doctype html><meta charset=utf-8><title>Bank</title>
<style>body{font:15px system-ui;max-width:42rem;margin:2rem auto;padding:0 1rem}
input,select,button{font:inherit;margin:.15rem}pre{background:#f4f4f4;padding:.75rem;overflow:auto}</style>
<h1>Bank</h1>
<p>As <input id=as value='customer:c-1' size=16> account <input id=account value='c-1-main' size=12></p>
<p><button onclick=\"send({type:'RegisterCustomer',customerId:'c-1',name:'Sam',username:'sam'})\">Register Sam</button>
<button onclick=\"send({type:'RegisterCustomer',customerId:'c-2',name:'Alex',username:'alex'})\">Register Alex</button></p>
<p><input id=amount value=100 size=8>
<button onclick=\"send({type:'DepositMoney',accountId:account.value,amount:+amount.value})\">Deposit</button>
<button onclick=\"send({type:'WithdrawMoney',accountId:account.value,amount:+amount.value})\">Withdraw</button>
<button onclick=\"send({type:'RequestTransfer',transferId:'t-'+Date.now(),from:account.value,to:'c-2-main',amount:+amount.value})\">Transfer to Alex</button></p>
<h2>Answer</h2><pre id=answer></pre><h2>Summary</h2><pre id=summary></pre><h2>Statement</h2><pre id=statement></pre>
<script>
const who = () => document.getElementById('as').value
async function show() {
  for (const name of ['summary', 'statement']) {
    const r = await fetch('/accounts/' + account.value + '/' + name + '?as=' + who())
    document.getElementById(name).textContent = JSON.stringify(await r.json(), null, 2)
  }
}
async function send(command) {
  const r = await fetch('/commands', {method: 'POST', body: JSON.stringify({as: who(), ...command})})
  answer.textContent = r.status + ' ' + JSON.stringify(await r.json(), null, 2)
  show()
}
show()
</script>"

def route (method path body : String) : Routed Bank :=
  let (path, query) :=
    match path.splitOn "?" with
    | [p, q] => (p, q.splitOn "&" |>.filterMap fun (pair : String) =>
        match pair.splitOn "=" with
        | [k, v] => some (k, v)
        | _ => none)
    | _ => (path, [])
  let actor := (query.lookup "as").bind actorOf
  let segments := (path.splitOn "/").filter (· ≠ "")
  let reading (respond : Actor → World BankSignature → Reply) : Routed Bank :=
    match actor with
    | some actor => .read (respond actor)
    | none => .refuse (refused 400 "say who is asking: ?as=customer:c-1")
  match method, segments with
  | "GET", [] => .read fun _ => { type := "text/html", body := page }
  | "POST", ["commands"] =>
    match (Json.parse body).toOption.bind asked with
    | some (actor, what) => command actor what
    | none => .refuse (refused 400 "not a command")
  | "GET", ["accounts", id, "summary"] =>
    reading fun actor w => guarded (Rejection := AccountRejection) (AccountSummary.read actor w.log id : Except AccountRejection Summary) fun s =>
      Json.mkObj [("customerId", s.customerId.elim Json.null Json.str),
        ("owner", s.owner.elim Json.null Json.str), ("balance", s.balance),
        ("frozen", s.frozen), ("closed", s.closed)]
  | "GET", ["accounts", id, "statement"] =>
    reading fun actor w => guarded (Rejection := AccountRejection) (AccountSummary.read actor w.log id : Except AccountRejection Summary) fun _ =>
      Json.arr ((Statement.emittedAt w.log id : List StatementLine).toArray.map lineJson)
  | "GET", ["accounts", id, "ledger"] =>
    reading fun actor w =>
      guarded (Rejection := AccountRejection) (AccountLedger.ask actor w.log id
          (after := ((query.lookup "after").bind String.toNat?).getD 0)
          (take := ((query.lookup "take").bind String.toNat?).getD 50)
          : Except AccountRejection (Page LedgerRow))
        fun page =>
          Json.mkObj [
            ("entries", Json.arr (page.entries.toArray.map fun (row : LedgerRow) =>
              Json.mkObj [("id", row.id), ("kind", reprStr row.kind), ("amount", row.amount),
                ("balanceAfter", row.balanceAfter), ("time", row.time)])),
            ("cursor", page.cursor.elim Json.null fun c => (c : Json))]
  | "GET", ["accounts", id, "card"] =>
    reading fun actor w => guarded (Rejection := AccountRejection) (AccountCard.read actor w.log id : Except AccountRejection (List CardChanged))
      fun cards => Json.arr (cards.toArray.map fun (card : CardChanged) =>
        Json.mkObj [("customerId", card.customerId), ("owner", card.owner),
          ("balance", card.balance), ("frozen", card.frozen)])
  | "GET", ["customers", id, "dashboard"] =>
    reading fun actor w => guarded (Rejection := String) (CustomerDashboard.read actor w.log id : Except String Dashboard) fun d =>
      Json.mkObj [("name", d.name.elim Json.null Json.str), ("totalBalance", d.totalBalance),
        ("balances", Json.mkObj (d.balances.map fun (account, balance) => (account, (balance : Json))))]
  | "GET", ["transfers", id] =>
    reading fun actor w => guarded (Rejection := AccountRejection) (TransferStatus.read actor w.log id : Except AccountRejection Status) fun s =>
      Json.mkObj [("status", reprStr s.progress), ("amount", s.amount.elim Json.null fun a => (a : Json)),
        ("failedReason", s.failedReason.elim Json.null Json.str)]
  | _, _ => .refuse (refused 404 "no such route")

/-- Asks an outside system over HTTP: the body of its answer, or nothing when it cannot be reached. -/
def ask (url : String) : IO (Option String) := do
  let out ← IO.Process.output { cmd := "curl", args := #["-fsS", "--max-time", "10", url] }
  pure (if out.exitCode = 0 then some out.stdout.trimAscii.toString else none)

/--
FraudCheck.score: asks the service at `FRAUD_URL` for a risk out of 100. With no
`FRAUD_URL`, a stand-in finds a day's outflow of 900.00 or more risky.
-/
def fraudScore (accountId : AccountId) (total : Cents) : IO FraudScore := do
  let standIn : FraudScore := ⟨if total ≥ 90000 then 95 else 10⟩
  match ← IO.getEnv "FRAUD_URL" with
  | none => pure standIn
  | some url =>
    match (← ask s!"{url}?accountId={accountId}&amount={total}").bind String.toNat? with
    | some risk => pure ⟨risk⟩
    | none => throw (IO.userError "the fraud service gave no score")

/--
Payments.refund: asks the service at `PAYMENTS_URL` to refund, and takes the
refund's id from its answer. With no `PAYMENTS_URL`, a stand-in makes one up.
-/
def refund (settlementId : String) (amount : Cents) : IO Refunded := do
  match ← IO.getEnv "PAYMENTS_URL" with
  | none => pure ⟨"re_" ++ settlementId⟩
  | some url =>
    match ← ask s!"{url}?settlementId={settlementId}&amount={amount}" with
    | some refundId => pure ⟨refundId⟩
    | none => throw (IO.userError "the payment processor did not refund")

/--
The bank's server. Each answer an outside system gives is written to the
journal, so a replay never asks again.
-/
def host : Host Bank where
  route := route
  adapter
    | .fraudScore accountId total => fraudScore accountId total
    | .refund settlementId amount => refund settlementId amount
  encodeReply
    | .fraudScore .., score => toString score.risk
    | .refund .., refunded => refunded.refundId
  decodeReply
    | .fraudScore .., text => text.toNat?.map fun risk => ⟨risk⟩
    | .refund .., text => some ⟨text⟩

end Bank
