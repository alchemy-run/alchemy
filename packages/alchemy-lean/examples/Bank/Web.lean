import Alchemy
import Bank.Server

/-!
The bank's pages. Each page is a function of the bank and of who is looking,
through the same guarded views the Api serves; each form sends a command through
the same Apis. `/app?as=customer:c-1` is a customer's page, `/app?as=agent:support-7`
an agent's. A page stays live: it loads again when anything is recorded.
-/

open Alchemy
open Alchemy.Html

namespace Bank

def actorText : Actor → String
  | .customer id => s!"customer:{id}"
  | .agent id => s!"agent:{id}"
  | .system name => s!"system:{name}"

def money (cents : Cents) : String :=
  let pennies := cents % 100
  s!"{cents / 100}.{if pennies < 10 then "0" else ""}{pennies}"

def lineKind : LineKind → String
  | .deposit => "deposit" | .withdrawal => "withdrawal" | .transferIn => "transfer in"
  | .transferOut => "transfer out" | .refund => "refund" | .settlement => "settlement"

def progressText : Progress → String
  | .completed => "completed" | .failed => "failed" | .inFlight => "in flight"
  | .awaitingApproval => "awaiting approval" | .pending => "pending"

/-- A form that sends a command as this actor. -/
def commandForm (actor : Actor) (type : String) (fixed : List (String × String))
    (inputs : List (String × String)) (button : String) : Html :=
  form "/app" (("as", actorText actor) :: ("type", type) :: fixed) inputs button

/-- One account, as its owner or an agent sees it. -/
def accountSection (actor : Actor) (w : World BankSignature) (id : AccountId) : List Html :=
  match AccountSummary.read actor w.log id with
  | .error _ => [h2 id, p [.text "You may not see this account."]]
  | .ok (summary : Summary) =>
    let lines : List StatementLine := Statement.emittedAt w.log id
    let moved : List TransferMoved := AccountTransfers.emittedAt w.log id
    [ h2 s!"Account {id}",
      p [.text s!"Balance {money summary.balance}"
        , .text (if summary.frozen then " · frozen" else "")
        , .text (if summary.closed then " · closed" else "")],
      commandForm actor "DepositMoney" [("accountId", id)] [("amount", "cents")] "Deposit",
      commandForm actor "WithdrawMoney" [("accountId", id)] [("amount", "cents")] "Withdraw",
      commandForm actor "RequestTransfer" [("from", id)]
        [("transferId", "transfer id"), ("to", "to account"), ("amount", "cents")] "Transfer",
      commandForm actor "CloseAccount" [("accountId", id)] [] "Close",
      table ["Statement", "Amount", "Balance"]
        (lines.map fun line => [lineKind line.kind, money line.amount, money line.balance]),
      table ["Transfer", "Direction", "Amount", "Status"]
        (moved.map fun m =>
          [m.transferId, (if m.direction = .incoming then "in" else "out"), money m.amount,
            progressText (TransferStatus.stateAt w.log m.transferId).progress]) ]

/-- The page for whoever is looking, with what the last command answered. -/
def view (actor : Actor) (note : Option String) (w : World BankSignature) : String :=
  let noted := match note with
    | some words => [Html.element "p" [("class", "note")] [.text words]]
    | none => []
  match actor with
  | .customer id =>
    let dashboard : Dashboard := CustomerDashboard.stateAt w.log id
    Html.page "Bank" ([h1 "Bank"] ++ noted ++
      (match dashboard.name with
        | some name =>
          [p [.text s!"{name}, your accounts hold {money dashboard.totalBalance}."]] ++
            (dashboard.balances.flatMap fun (account, _) => accountSection actor w account)
        | none =>
          [p [.text "You are not registered yet."],
            commandForm actor "RegisterCustomer" [("customerId", id)]
              [("name", "name"), ("username", "username")] "Register"]) ++
      [p [link "/app?as=agent:support-7" "Look as a support agent"], live "/version"])
  | _ =>
    let waiting := (w.toRecorded.ids .transfer).filter fun id =>
      w.state .transfer id matches .awaitingApproval _
    let accounts := w.toRecorded.ids .account
    Html.page "Bank: support" ([h1 "Bank: support"] ++ noted ++
      [h2 "Transfers waiting for approval",
        table ["Transfer"] (waiting.map fun id => [id])] ++
      (waiting.map fun id =>
        commandForm actor "ApproveTransfer" [("transferId", id)] [] s!"Approve {id}") ++
      [h2 "Accounts",
        table ["Account", "Owner", "Balance", "Frozen", "Closed"]
          (accounts.map fun id =>
            let s : Summary := AccountSummary.stateAt w.log id
            [id, s.owner.getD "", money s.balance, toString s.frozen, toString s.closed])] ++
      (accounts.map fun id =>
        commandForm actor "FreezeAccount" [("accountId", id)] [("reason", "reason")] s!"Freeze {id}")
      ++ [live "/version"])

/-- The command a posted form asks for: the same commands the Api takes as JSON. -/
def formCommand (body : String) : Option (Actor × Asked) :=
  asked (Lean.Json.mkObj ((fields body).map fun (k, v) =>
    (k, if k = "amount" then (match v.toNat? with | some n => (n : Lean.Json) | none => v) else v)))

/-- What the command did, in a sentence. -/
def said (reply : Reply) : String :=
  if reply.status = 200 then "Done." else s!"Refused: {reply.body}"

/-- The pages' routes, over the Api's. -/
def routeWithPages (method path body : String) : Routed Bank :=
  let (base, query) :=
    match path.splitOn "?" with
    | [p, q] => (p, q)
    | _ => (path, "")
  if base = "/version" then
    -- How much has been recorded: a page that watches this stays live.
    .read fun w => { type := "text/plain", body := toString w.log.length }
  else if base = "/app" then
    if method = "POST" then
      match formCommand body with
      | some (actor, what) =>
        match command actor what with
        | .move move respond => .move move fun before after =>
          { type := "text/html", body := view actor (some (said (respond before after))) after }
        | .refuse reply => .read fun w => { type := "text/html", body := view actor (some (said reply)) w }
        | .read _ => .refuse (refused 400 "not a command")
      | none => .refuse (refused 400 "not a command")
    else
      match ((fields query).lookup "as").bind actorOf with
      | some actor => .read fun w => { type := "text/html", body := view actor none w }
      | none => .read fun w => { type := "text/html", body := view (.customer "c-1") none w }
  else route method path body

/-- The bank's server: its Api, its pages, and its stand-ins for the outside systems. -/
def hostWithPages : Host Bank := { host with route := routeWithPages }

end Bank
