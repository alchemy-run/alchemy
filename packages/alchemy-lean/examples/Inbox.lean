import Alchemy

/-!
# An inbox, on Cloudflare Workers

A Worker written as one `do` block: it consumes a queue, and ends with what it
serves, a `fetch` handler and methods another Worker calls. Nobody lists its
bindings: they are read off the calls in its code.
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

/-- Stores a message under the next number. -/
helper store {role : Access Kind} (mail : Bucket) (message : String) : Run role Never Unit := do
  let stored ← R2.list mail
  R2.put mail (toString stored.length) message

/--
Accepts messages over HTTP and puts them on a queue; consumes the queue and
stores each message; tells other Workers what is stored.
-/
def Inbox (mail : Bucket) (incoming : Queue) : Construct Kind (Worker Api) :=
  Workers.Worker "Inbox" {} Api do
    Queues.consume incoming fun message => store mail message

    return {
      fetch := fun request => do
        match request.method, request.path with
        | "POST", "/messages" =>
          if request.body.isEmpty then return { status := 400, body := "a message needs a body" }
          Queues.send incoming request.body
          return { status := 202 }
        | _, _ => return { status := 404 }
      rpc := fun
        | .count => return (← R2.list mail).length
        | .read id => R2.get mail (toString id) }

/-- A page that says what is in the inbox. It holds no data: it asks the Inbox. -/
def Web (inbox : Worker Api) : Construct Kind (Worker .none) :=
  Workers.Worker "Web" {} .none do
    return {
      fetch := fun request => do
        match request.path with
        | "/" =>
          match ← (Workers.call inbox .count).result with
          | .ok count => return { body := s!"{count} messages" }
          | .error (_ : Workers.RpcError) => return { status := 502, body := "the inbox did not answer" }
        | "/latest" =>
          match ← (do
              let count ← Workers.call inbox .count
              Workers.call inbox (.read (count - 1))).result with
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

/-! ## Tests of the stack, run in memory -/

abbrev Test := List (Graph.Step Kind (InMemory prod))

def post (body : String) : Incoming := .fetch { method := "POST", path := "/messages", body }
def get (path : String) : Incoming := .fetch { path }

def aMessage : Test := [
  .request web (get "/") (responds { body := "0 messages" }),
  .request web (get "/latest") (responds { status := 404, body := "the inbox is empty" }),
  .request inbox (post "hello") (responds { status := 202 }),
  .holds "the consumer stored it" (·.object mail "0" == some "hello"),
  .request inbox (post "") (responds { status := 400, body := "a message needs a body" }),
  .request inbox (post "again") (responds { status := 202 }),
  .request web (get "/") (responds { body := "2 messages" }),
  .request web (get "/latest") (responds { body := "again" }) ]

example : prod.passes aMessage = true := by native_decide

/-! ## What is proved about access -/

/--
Least privilege. No Worker holds a binding it does not need: for each one,
there is a run in which that Worker makes a call only that binding permits.
Bind something a Worker never uses and this fails.
-/
theorem leastPrivilege : prod.LeastPrivilege (InMemory prod) :=
  .of_tests [aMessage] (by native_decide)

/-- Only the Inbox can touch the mail, to read it or to write it. -/
theorem onlyTheInboxTouchesTheMail :
    prod.only [inbox] (R2.reading mail) ∧ prod.only [inbox] (R2.writing mail) := by
  constructor <;> stack_rule in prod using [mail, inbox]

/-- Nothing but the Web can call the Inbox, and nothing can call the Web. -/
theorem whoCallsWhom :
    prod.whoCan ⟨.worker, inbox, WorkerOp.call⟩ = ["Web"] ∧
      prod.whoCan ⟨.worker, web, WorkerOp.call⟩ = [] := by
  constructor <;> rfl

/-! ## What the consumer does, for every message -/

/--
Given whatever mail is stored, when a message is consumed, then it is stored
under the next number: one more than the mail already there.
-/
theorem aConsumedMessageIsStoredNext {role : Access Kind} [store.Needs role mail]
    (message : String) (cloud : Memory) :
    ((store (role := role) mail message).eval (InMemory prod) cloud).2.object mail
        (toString (cloud.keys mail).length)
      = some message := by
  show (Run.eval (InMemory prod) (Run.bind _ _) cloud).2.object mail _ = _
  rw [Run.eval_bind, R2.list_eval]
  show (Run.eval (InMemory prod) (R2.put mail (toString (cloud.keys mail).length) message) cloud).2.object
    mail _ = _
  rw [R2.put_eval]
  exact Memory.object_written cloud mail _ message

/-! ## Deploying it -/

/-- The first deploy creates everything, each resource after what it needs. -/
example : plan Control.providers prod (⟨.empty, {}⟩ : Cloud.World Kind Control.Service).state = [
    ("Mail", .create), ("Incoming", .create), ("Inbox", .create), ("Web", .create)] := by
  native_decide

/--
Deploying this stack to a fresh account leaks nothing, whatever fails: every
resource in the account is one the engine's state knows about. It is the same
guarantee an AWS stack has, from the same engine.
-/
theorem deployLeaksNothing :
    Tracked Control.lawful
      (apply Control.providers Control.Service prod (⟨.empty, {}⟩ : Cloud.World Kind Control.Service)).1 :=
  apply_tracked Control.lawful prod _ (by
    intro y present
    simp [Control.lawful] at present)

end Inbox
