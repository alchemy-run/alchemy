import Alchemy.Cloud.Host
import Alchemy.Cloud.Infer
import Alchemy.Cloud.Tactics
import Alchemy.Cloud.Laws
import Alchemy.Cloud.Hosted

/-!
# A small Cloudflare

Workers, R2 buckets and Queues. A Worker is written as a `do` block: a queue
consumer is a step, and it ends with what the Worker serves, a `fetch` handler
and typed methods other Workers can call. Its bindings are read off its calls.
-/

namespace Alchemy.Cloudflare
open Alchemy.Cloud

inductive Kind where
  | bucket
  | queue
  | worker
deriving DecidableEq, Repr

/-! ## Access -/

inductive BucketOp where
  | read
  | write
deriving DecidableEq, Repr

inductive QueueOp where
  | send
deriving DecidableEq, Repr

inductive WorkerOp where
  | call
deriving DecidableEq, Repr

abbrev Op : Kind → Type
  | .bucket => BucketOp
  | .queue => QueueOp
  | .worker => WorkerOp

instance : (k : Kind) → DecidableEq (Op k)
  | .bucket => inferInstanceAs (DecidableEq BucketOp)
  | .queue => inferInstanceAs (DecidableEq QueueOp)
  | .worker => inferInstanceAs (DecidableEq WorkerOp)

instance : Kinds Kind where
  Op := Op

/-! ## Configuration, calls and events -/

structure BucketProps where
deriving DecidableEq, Repr

structure QueueProps where
  /-- Messages delivered to a consumer at once. -/
  batchSize : Nat := 10
deriving DecidableEq, Repr

structure WorkerProps where
  compatibilityDate : String := "2026-01-01"
deriving DecidableEq, Repr

abbrev Props : Kind → Type
  | .bucket => BucketProps
  | .queue => QueueProps
  | .worker => WorkerProps

inductive BucketCall where
  | get (key : String)
  | put (key body : String)
  | list

inductive QueueCall where
  | send (body : String)

inductive WorkerCall where
  /-- A method of another Worker, with its arguments, as text. -/
  | rpc (method : String)

abbrev Call : Kind → Type
  | .bucket => BucketCall
  | .queue => QueueCall
  | .worker => WorkerCall

abbrev Reply : {k : Kind} → Call k → Type
  | .bucket, .get _ => Option String
  | .bucket, .put .. => Unit
  | .bucket, .list => List String
  | .queue, .send _ => Unit
  | .worker, .rpc _ => Option String

def needs : {k : Kind} → Call k → Op k
  | .bucket, .get _ => .read
  | .bucket, .put .. => .write
  | .bucket, .list => .read
  | .queue, .send _ => .send
  | .worker, .rpc _ => .call

structure Request where
  method : String := "GET"
  path : String := "/"
  body : String := ""
deriving DecidableEq, Repr

structure Response where
  status : Nat := 200
  body : String := ""
deriving DecidableEq, Repr

/-- What reaches a Worker: a request over HTTP, or a call from another Worker. -/
inductive Incoming where
  | fetch (request : Request)
  | rpc (method : String)

inductive Outgoing where
  | http (response : Response)
  | value (reply : String)
  | unknownMethod
deriving DecidableEq, Repr

instance : Cloud Kind where
  Props := Props
  Call := Call
  Reply := Reply
  needs := needs
  /- A queue tells its consumers each message. -/
  Event := fun
    | .queue => String
    | _ => Empty
  Request := fun
    | .worker => Incoming
    | _ => Empty
  Response := fun
    | .worker => Outgoing
    | _ => Empty

/-! ## Resources -/

abbrev Bucket := Ref Kind.bucket
abbrev Queue := Ref Kind.queue

namespace R2

def Bucket (id : String) (props : BucketProps := {}) : Construct Kind Cloudflare.Bucket :=
  resource Kind.bucket id props

end R2

namespace Queues

def Queue (id : String) (props : QueueProps := {}) : Construct Kind Cloudflare.Queue :=
  resource Kind.queue id props

end Queues

/-! ## Consumers -/

namespace Queues

/--
Consume a queue: run this for each message. A step of the Worker's block, so the
Worker is registered as the queue's consumer when the stack is built.
-/
def consume {role : Access Kind} {ε : Type} [Repr ε] (queue : Cloudflare.Queue)
    (handle : String → Run role ε Unit) : Host role Unit :=
  Host.listen {
    kind := .queue
    source := queue
    handle := fun (message : String) => (handle message).mapError reprStr }

end Queues

/-! ## Workers -/

/-- What a Worker offers other Workers: its methods, and what each answers. -/
structure Rpc where
  Method : Type
  Reply : Method → Type
  [method : Text Method]
  reply : (c : Method) → Text (Reply c) := by intro c; cases c <;> exact inferInstance

/-- No methods. -/
def Rpc.none : Rpc where
  Method := Empty
  Reply := fun _ => Empty
  method := { write := nofun, read := fun _ => Option.none }
  reply := fun c => nomatch c

/-- A Worker, by the methods it offers. -/
structure Worker (rpc : Rpc) where
  ref : Ref Kind.worker

/-- What a Worker serves. -/
structure Handlers (rpc : Rpc) (role : Access Kind) where
  fetch : Request → Run role Never Response := fun _ => pure { status := 404 }
  rpc : (c : rpc.Method) → Run role Never (rpc.Reply c) := by intro c; exact nomatch c

namespace Workers

/--
A Worker. Its block binds what it uses, registers what it consumes, and ends
with what it serves.
-/
def Worker (id : String) (props : WorkerProps) (rpc : Rpc := .none)
    (body : {role : Access Kind} → Host role (Handlers rpc role)) :
    Construct Kind (Cloudflare.Worker rpc) := do
  let ref ← hostOf Kind.worker id props do
    let handlers ← body
    return fun
      | Incoming.fetch request => return Outgoing.http (← handlers.fetch request)
      | Incoming.rpc text =>
        match rpc.method.read text with
        | some c => return Outgoing.value ((rpc.reply c).write (← handlers.rpc c))
        | none => return Outgoing.unknownMethod
  return ⟨ref⟩

/-- How a call to another Worker can fail. -/
inductive RpcError where
  | unknownMethod
  | unreadable (reply : String)
deriving DecidableEq, Repr

end Workers

/-! ## Operations called directly: the call is what asks for the binding -/

namespace R2

/-- Read an object. -/
def get {role : Access Kind} (bucket : Cloudflare.Bucket) (key : String)
    [granted : Has role (.on bucket BucketOp.read)] : Run role Never (Option String) :=
  Run.perform bucket (BucketCall.get key) granted

/-- The keys of a bucket. -/
def list {role : Access Kind} (bucket : Cloudflare.Bucket)
    [granted : Has role (.on bucket BucketOp.read)] : Run role Never (List String) :=
  Run.perform bucket BucketCall.list granted

/-- Write an object. -/
def put {role : Access Kind} (bucket : Cloudflare.Bucket) (key body : String)
    [granted : Has role (.on bucket BucketOp.write)] : Run role Never Unit :=
  Run.perform bucket (BucketCall.put key body) granted

/-- Reading a bucket. -/
abbrev reading (bucket : Cloudflare.Bucket) : Doing Kind := ⟨Unit, fun _ => ⟨.bucket, bucket, BucketOp.read⟩⟩

/-- Writing a bucket. -/
abbrev writing (bucket : Cloudflare.Bucket) : Doing Kind := ⟨Unit, fun _ => ⟨.bucket, bucket, BucketOp.write⟩⟩

end R2

namespace Queues

/-- Put a message on a queue. -/
def send {role : Access Kind} (queue : Cloudflare.Queue) (body : String)
    [granted : Has role (.on queue QueueOp.send)] : Run role Never Unit :=
  Run.perform queue (QueueCall.send body) granted

/-- Putting messages on a queue. -/
abbrev sending (queue : Cloudflare.Queue) : Doing Kind := ⟨Unit, fun _ => ⟨.queue, queue, QueueOp.send⟩⟩

end Queues

namespace Workers

/-- Call a method of another Worker. -/
def call {role : Access Kind} {rpc : Rpc} (worker : Cloudflare.Worker rpc) (c : rpc.Method)
    [granted : Has role (.on worker.ref WorkerOp.call)] : Run role RpcError (rpc.Reply c) := do
  match ← Run.perform worker.ref (WorkerCall.rpc (rpc.method.write c)) granted with
  | none => .fail .unknownMethod
  | some text =>
    match (rpc.reply c).read text with
    | some reply => pure reply
    | none => .fail (.unreadable text)

/-- Calling a Worker's methods. -/
abbrev calling {rpc : Rpc} (worker : Cloudflare.Worker rpc) : Doing Kind :=
  ⟨Unit, fun _ => ⟨.worker, worker.ref, WorkerOp.call⟩⟩

end Workers

/-- A Worker's block has its bindings read off the calls in it. -/
macro_rules
  | `(Workers.Worker $id $props $rpc $body) =>
    `(Alchemy.Cloudflare.Workers.Worker $id $props $rpc (granted% $body))

/-! ## In memory -/

structure Memory where
  objects : List (String × String × String) := []
  /-- Every message ever put on a queue. -/
  sent : List (String × String) := []
deriving DecidableEq, Repr

namespace Memory

def object (m : Memory) (bucket : Cloudflare.Bucket) (key : String) : Option String :=
  (m.objects.find? fun (id, k, _) => id == bucket.id && k == key).map (·.2.2)

def keys (m : Memory) (bucket : Cloudflare.Bucket) : List String :=
  (m.objects.filter (·.1 == bucket.id)).map (·.2.1)

end Memory

/--
What each call does. A call to a Worker runs that Worker's method, to a depth:
a Worker that calls itself for ever is cut off.
-/
def simulate (g : Graph Kind) :
    Nat → {k : Kind} → Ref k → (c : Call k) → Memory → Reply c × Memory × List (Cloud.Emitted Kind)
  | depth, k, ref, c, m =>
    match k, ref, c with
    | .bucket, bucket, .get key => (m.object bucket key, m, [])
    | .bucket, bucket, .put key body =>
      ((), { m with
          objects := (m.objects.filter fun (id, k, _) => !(id == bucket.id && k == key))
            ++ [(bucket.id, key, body)] }, [])
    | .bucket, bucket, .list => (m.keys bucket, m, [])
    | .queue, queue, .send body =>
      ((), { m with sent := m.sent ++ [(queue.id, body)] },
        [(⟨Kind.queue, queue, body⟩ : Cloud.Emitted Kind)])
    | .worker, worker, .rpc method =>
      match depth with
      | 0 => (none, m, [])
      | depth + 1 =>
        match g.handler worker (Incoming.rpc method) with
        | none => (none, m, [])
        | some ⟨_, run⟩ =>
          let out := run.exec { State := Memory, init := {}, call := simulate g depth } m
          (match out.result with
            | .ok (Outgoing.value reply) => some reply
            | _ => none, out.state, out.events)

/-- Cloudflare, in memory, running the Workers of a graph. -/
abbrev InMemory (g : Graph Kind) (depth : Nat := 8) : Sim Kind where
  State := Memory
  init := {}
  call := simulate g depth

/-! ## What the operations do

Each operation, against the model: what it answers and what it leaves.
-/

/-- What was just written at a key is what the bucket holds there. -/
theorem Memory.object_written (m : Memory) (bucket : Cloudflare.Bucket) (key body : String) :
    ({ m with
        objects := (m.objects.filter fun (id, k, _) => !(id == bucket.id && k == key))
          ++ [(bucket.id, key, body)] } : Memory).object bucket key = some body := by
  simp only [Memory.object, List.find?_append]
  rw [List.find?_eq_none.mpr]
  · simp
  · intro x mem
    simp only [List.mem_filter] at mem
    have differs := mem.2
    simp only [Bool.not_eq_true', Bool.and_eq_false_iff, beq_eq_false_iff_ne] at differs
    intro same
    simp only [Bool.and_eq_true, beq_iff_eq] at same
    rcases differs with n | n
    · exact n same.1
    · exact n same.2

section Laws
variable {role : Access Kind} (g : Graph Kind) (depth : Nat)

/-- Reading answers what the bucket holds at the key, and changes nothing. -/
theorem R2.get_eval (bucket : Cloudflare.Bucket) (key : String)
    [Has role (.on bucket BucketOp.read)] (m : Memory) :
    (R2.get (role := role) bucket key).eval (InMemory g depth) m = (.ok (m.object bucket key), m) := by
  cases depth <;> rfl

/-- Listing answers the bucket's keys, and changes nothing. -/
theorem R2.list_eval (bucket : Cloudflare.Bucket) [Has role (.on bucket BucketOp.read)]
    (m : Memory) :
    (R2.list (role := role) bucket).eval (InMemory g depth) m = (.ok (m.keys bucket), m) := by
  cases depth <;> rfl

/-- Writing leaves the object at the key, replacing whatever was there. -/
theorem R2.put_eval (bucket : Cloudflare.Bucket) (key body : String)
    [Has role (.on bucket BucketOp.write)] (m : Memory) :
    (R2.put (role := role) bucket key body).eval (InMemory g depth) m
      = (.ok (), { m with
          objects := (m.objects.filter fun (id, k, _) => !(id == bucket.id && k == key))
            ++ [(bucket.id, key, body)] }) := by
  cases depth <;> rfl

/-- Sending records the message, and touches no object. -/
theorem Queues.send_eval (queue : Cloudflare.Queue) (body : String)
    [Has role (.on queue QueueOp.send)] (m : Memory) :
    (Queues.send (role := role) queue body).eval (InMemory g depth) m
      = (.ok (), { m with sent := m.sent ++ [(queue.id, body)] }) := by
  cases depth <;> rfl

end Laws

/-- A test's expectation: the Worker answers exactly this over HTTP. -/
def responds (expected : Response) : Cloud.Response Kind.worker → Bool :=
  fun (got : Outgoing) => got == .http expected

end Alchemy.Cloudflare
