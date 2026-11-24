import Alchemy.Cloud.Host
import Alchemy.Cloud.Hosted

/-!
# A small Cloudflare

Workers, R2 buckets and Queues. A Worker is written as a `do` block: bindings
and queue consumers are steps, and it ends with what the Worker serves, a
`fetch` handler and typed methods other Workers can call.
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

/-! ## Bindings -/

variable {m : Type → Type} {access : Access Kind}

namespace R2

structure Read.Client (bucket : Cloudflare.Bucket) (access : Access Kind) where
  get : String → Run access Never (Option String)
  list : Run access Never (List String)

instance (bucket : Cloudflare.Bucket) : Live (Read.Client bucket) where
  layer := {
    needs := .on bucket BucketOp.read
    build := fun le _ => {
      get := fun key => Run.perform bucket (BucketCall.get key) ⟨le⟩
      list := Run.perform bucket BucketCall.list ⟨le⟩ } }

/-- Read a bucket. -/
def Read (bucket : Cloudflare.Bucket) [Gives m (Read.Client bucket) access] :
    m (Read.Client bucket access) :=
  Layer.Gives.give

structure ReadWrite.Client (bucket : Cloudflare.Bucket) (access : Access Kind) where
  get : String → Run access Never (Option String)
  list : Run access Never (List String)
  put : String → String → Run access Never Unit

instance (bucket : Cloudflare.Bucket) : Live (ReadWrite.Client bucket) where
  layer := {
    needs := .on bucket BucketOp.read ∪ .on bucket BucketOp.write
    build := fun le _ =>
      let read := Access.le_trans (Access.le_union_left _ _) le
      let write := Access.le_trans (Access.le_union_right _ _) le
      { get := fun key => Run.perform bucket (BucketCall.get key) ⟨read⟩
        list := Run.perform bucket BucketCall.list ⟨read⟩
        put := fun key body => Run.perform bucket (BucketCall.put key body) ⟨write⟩ } }

/-- Read and write a bucket. -/
def ReadWrite (bucket : Cloudflare.Bucket) [Gives m (ReadWrite.Client bucket) access] :
    m (ReadWrite.Client bucket access) :=
  Layer.Gives.give

end R2

namespace Queues

structure Send.Client (queue : Cloudflare.Queue) (access : Access Kind) where
  send : String → Run access Never Unit

instance (queue : Cloudflare.Queue) : Live (Send.Client queue) where
  layer := {
    needs := .on queue QueueOp.send
    build := fun le _ => { send := fun body => Run.perform queue (QueueCall.send body) ⟨le⟩ } }

/-- Put messages on a queue. -/
def Send (queue : Cloudflare.Queue) [Gives m (Send.Client queue) access] :
    m (Send.Client queue access) :=
  Layer.Gives.give

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

structure Bind.Client {rpc : Rpc} (worker : Cloudflare.Worker rpc) (access : Access Kind) where
  call : (c : rpc.Method) → Run access RpcError (rpc.Reply c)

instance {rpc : Rpc} (worker : Cloudflare.Worker rpc) : Live (Bind.Client worker) where
  layer := {
    needs := .on worker.ref WorkerOp.call
    build := fun le _ => {
      call := fun c => do
        match ← Run.perform worker.ref (WorkerCall.rpc (rpc.method.write c)) ⟨le⟩ with
        | none => .fail .unknownMethod
        | some text =>
          match (rpc.reply c).read text with
          | some reply => pure reply
          | none => .fail (.unreadable text) } }

/-- Call another Worker's methods. -/
def Bind {rpc : Rpc} (worker : Cloudflare.Worker rpc) [Gives m (Bind.Client worker) access] :
    m (Bind.Client worker access) :=
  Layer.Gives.give

end Workers

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
def InMemory (g : Graph Kind) (depth : Nat := 8) : Sim Kind where
  State := Memory
  init := {}
  call := simulate g depth

/-- A test's expectation: the Worker answers exactly this over HTTP. -/
def responds (expected : Response) : Cloud.Response Kind.worker → Bool :=
  fun (got : Outgoing) => got == .http expected

end Alchemy.Cloudflare
