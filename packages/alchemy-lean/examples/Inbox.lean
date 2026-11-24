import Alchemy

/-!
# An inbox, on Cloudflare Workers

A Worker written as one `do` block: it binds a bucket and a queue, consumes the
queue, and ends with what it serves, a `fetch` handler and methods another
Worker calls. Nobody lists its bindings or writes its role: both are what the
steps of the block asked for.
-/

open Alchemy Cloud Cloudflare

namespace Inbox

/-! ## What the Inbox Worker offers other Workers -/

inductive Method where
  | count
  | read (id : Nat)
deriving DecidableEq, Repr, Lean.ToJson, Lean.FromJson

abbrev Api : Rpc where
  Method := Method
  Reply
    | .count => Nat
    | .read _ => Option String

/-! ## The Workers -/

/--
Accepts messages over HTTP and puts them on a queue; consumes the queue and
stores each message; tells other Workers what is stored.
-/
def Inbox (mail : Bucket) (incoming : Queue) : Construct Kind (Worker Api) :=
  Workers.Worker "Inbox" {} Api do
    let mail ← R2.ReadWrite mail
    let queue ← Queues.Send incoming

    Queues.consume incoming fun message => do
      let stored ← mail.list
      mail.put (toString stored.length) message

    return {
      fetch := fun request => do
        match request.method, request.path with
        | "POST", "/messages" =>
          if request.body.isEmpty then return { status := 400, body := "a message needs a body" }
          queue.send request.body
          return { status := 202 }
        | _, _ => return { status := 404 }
      rpc := fun
        | .count => return (← mail.list).length
        | .read id => mail.get (toString id) }

/-- A page that says what is in the inbox. It holds no data: it asks the Inbox. -/
def Web (inbox : Worker Api) : Construct Kind (Worker .none) :=
  Workers.Worker "Web" {} .none do
    let inbox ← Workers.Bind inbox
    return {
      fetch := fun request => do
        match request.path with
        | "/" =>
          match ← (inbox.call .count).result with
          | .ok count => return { body := s!"{count} messages" }
          | .error (_ : Workers.RpcError) => return { status := 502, body := "the inbox did not answer" }
        | "/latest" =>
          match ← (do
              let count ← inbox.call .count
              inbox.call (.read (count - 1))).result with
          | .ok (some message) => return { body := message }
          | .ok none => return { status := 404, body := "the inbox is empty" }
          | .error (_ : Workers.RpcError) => return { status := 502, body := "the inbox did not answer" }
        | _ => return { status := 404 } }

/-! ## The stack -/

structure Outputs where
  inbox : Worker Api
  web : Worker .none

def InboxStack : Stack Kind Outputs where
  name := "Inbox"
  body := do
    let mail ← R2.Bucket "Mail"
    let incoming ← Queues.Queue "Incoming"
    let inbox ← Inbox mail incoming
    let web ← Web inbox
    return { inbox, web }

def prod : Graph Kind := InboxStack.graph "prod"

def mail : Bucket := ⟨"Mail"⟩
def incoming : Queue := ⟨"Incoming"⟩
def inbox : Ref Kind.worker := ⟨"Inbox"⟩
def web : Ref Kind.worker := ⟨"Web"⟩

example : InboxStack.problem "prod" = none ∧ prod.deployable = true := by decide

/-- The edges: the Inbox uses the bucket and the queue, and consumes the queue; the Web calls the Inbox. -/
example : prod.edges = [
    ("Inbox", "Mail"), ("Inbox", "Incoming"), ("Web", "Inbox")] := by decide

/-! ## What is proved about access -/

/-- Each Worker's bindings. Nobody wrote these down: each is what its block asked for. -/
theorem roles : prod.roles = [
    ("Mail", ∅),
    ("Incoming", ∅),
    ("Inbox", .on mail BucketOp.read ∪ .on mail BucketOp.write ∪ .on incoming QueueOp.send),
    ("Web", .on inbox WorkerOp.call)] := by
  rfl

/-- Only the Inbox can touch the mail, to read it or to write it. -/
theorem onlyTheInboxTouchesTheMail (op : BucketOp) (host : String)
    (can : host ∈ prod.whoCan ⟨.bucket, mail, op⟩) : host = "Inbox" := by
  access [roles]
  grind

/-! ## Stories, run against the stack in memory -/

abbrev Story := List (Graph.Step Kind (InMemory prod))

def post (body : String) : Incoming := .fetch { method := "POST", path := "/messages", body }
def get (path : String) : Incoming := .fetch { path }

def aMessage : Story := [
  .request web (get "/") (responds { body := "0 messages" }),
  .request web (get "/latest") (responds { status := 404, body := "the inbox is empty" }),
  .request inbox (post "hello") (responds { status := 202 }),
  .holds "the consumer stored it" (·.object mail "0" == some "hello"),
  .request inbox (post "") (responds { status := 400, body := "a message needs a body" }),
  .request inbox (post "again") (responds { status := 202 }),
  .request web (get "/") (responds { body := "2 messages" }),
  .request web (get "/latest") (responds { body := "again" }) ]

example : prod.passes aMessage = true := by native_decide

/-- Least privilege, checked: the story uses every binding of every Worker. -/
example : prod.exercised [aMessage] = true := by native_decide

end Inbox
