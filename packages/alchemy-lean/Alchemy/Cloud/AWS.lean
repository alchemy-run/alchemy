import Alchemy.Cloud.Sim

/-!
# A small AWS

Buckets, queues and functions: their access, their calls, and what each call
does in memory. Enough to show the graph; not a provider.
-/

namespace Alchemy.AWS
open Alchemy.Cloud

abbrev Path := List String

inductive Kind where
  | bucket
  | queue
  | function
deriving DecidableEq, Repr

/-! ## Access -/

inductive BucketOp where
  /-- Read objects whose key is under a prefix. -/
  | get (under : Path)
  /-- Write objects whose key is under a prefix. -/
  | put (under : Path)
  | list
deriving DecidableEq, Repr

inductive QueueOp where
  | send
  | receive
deriving DecidableEq, Repr

inductive FunctionOp where
  | invoke
deriving DecidableEq, Repr

abbrev Op : Kind → Type
  | .bucket => BucketOp
  | .queue => QueueOp
  | .function => FunctionOp

instance : (k : Kind) → DecidableEq (Op k)
  | .bucket => inferInstanceAs (DecidableEq BucketOp)
  | .queue => inferInstanceAs (DecidableEq QueueOp)
  | .function => inferInstanceAs (DecidableEq FunctionOp)

/-- A grant on a prefix covers every key under it. -/
def BucketOp.covers : BucketOp → BucketOp → Bool
  | .get under, .get key => under.isPrefixOf key
  | .put under, .put key => under.isPrefixOf key
  | _, _ => false

instance : Kinds Kind where
  Op := Op
  covers {k} := match k with
    | .bucket => BucketOp.covers
    | _ => fun _ _ => false

/-! ## Configuration, calls and events -/

structure BucketProps where
  versioned : Bool := false
deriving DecidableEq, Repr

structure QueueProps where
  /-- First in, first out. Fixed when the queue is created. -/
  fifo : Bool := false
  /-- Seconds a received message stays hidden. -/
  visibilityTimeout : Nat := 30
deriving DecidableEq, Repr

structure FunctionProps where
  url : Bool := false
  memory : Nat := 512
deriving DecidableEq, Repr

abbrev Props : Kind → Type
  | .bucket => BucketProps
  | .queue => QueueProps
  | .function => FunctionProps

inductive BucketCall where
  | getObject (key : Path)
  | putObject (key : Path) (body : String)
  | listObjects

inductive QueueCall where
  | sendMessage (body : String)
  | receiveMessage

abbrev Call : Kind → Type
  | .bucket => BucketCall
  | .queue => QueueCall
  | .function => Empty

abbrev BucketCall.Reply : BucketCall → Type
  | .getObject _ => Option String
  | .putObject .. => Unit
  | .listObjects => List Path

abbrev QueueCall.Reply : QueueCall → Type
  | .sendMessage _ => Unit
  | .receiveMessage => Option String

abbrev Reply : {k : Kind} → Call k → Type
  | .bucket, c => BucketCall.Reply c
  | .queue, c => QueueCall.Reply c

def needs : {k : Kind} → Call k → Op k
  | .bucket, .getObject key => .get key
  | .bucket, .putObject key _ => .put key
  | .bucket, .listObjects => .list
  | .queue, .sendMessage _ => .send
  | .queue, .receiveMessage => .receive

inductive BucketEvent where
  | objectCreated (key : Path)

abbrev Event : Kind → Type
  | .bucket => BucketEvent
  | _ => Empty

inductive Method where
  | get
  | post
deriving DecidableEq, Repr

structure Request where
  method : Method := .get
  path : Path := []
  body : String := ""
deriving DecidableEq, Repr

structure Response where
  status : Nat
  body : String := ""
deriving DecidableEq, Repr

instance : Cloud Kind where
  Props := Props
  Call := Call
  Reply := Reply
  needs := needs
  Event := Event
  Request := fun
    | .function => Request
    | _ => Empty
  Response := fun
    | .function => Response
    | _ => Empty

/-! ## The handles a program holds -/

abbrev Bucket := Ref Kind.bucket
abbrev Queue := Ref Kind.queue
abbrev Function := Ref Kind.function

namespace S3

def Bucket (id : String) (props : BucketProps := {}) : Construct Kind AWS.Bucket :=
  resource Kind.bucket id props

/-- Read the objects of a bucket under a prefix. With no prefix, all of them. -/
abbrev Get (bucket : AWS.Bucket) (under : Path := []) : Access Kind := .on bucket (BucketOp.get under)

/-- Write the objects of a bucket under a prefix. With no prefix, all of them. -/
abbrev Put (bucket : AWS.Bucket) (under : Path := []) : Access Kind := .on bucket (BucketOp.put under)

abbrev List (bucket : AWS.Bucket) : Access Kind := .on bucket BucketOp.list

variable {access : Access Kind} {ε : Type}

/-- Read `under/name`. Needs read access to `under`. -/
def getObject (bucket : AWS.Bucket) (under : Path) (name : String)
    [h : Has access (Get bucket under)] : Run access ε (Option String) :=
  Run.performUnder bucket (BucketCall.getObject (under ++ [name])) (BucketOp.get under) h
    (by simp [Cloud.needs, AWS.needs, Kinds.covers, BucketOp.covers])

/-- Write `under/name`. Needs write access to `under`. -/
def putObject (bucket : AWS.Bucket) (under : Path) (name : String) (body : String)
    [h : Has access (Put bucket under)] : Run access ε Unit :=
  Run.performUnder bucket (BucketCall.putObject (under ++ [name]) body) (BucketOp.put under) h
    (by simp [Cloud.needs, AWS.needs, Kinds.covers, BucketOp.covers])

def listObjects (bucket : AWS.Bucket) [h : Has access (List bucket)] : Run access ε (_root_.List Path) :=
  Run.perform bucket BucketCall.listObjects h

/-- Run this whenever an object is created in the bucket. -/
def onObjectCreated (bucket : AWS.Bucket) (handle : Path → Run access Failure Unit) :
    Subscription access where
  kind := .bucket
  source := bucket
  handle := fun
    | .objectCreated key => handle key

end S3

namespace SQS

def Queue (id : String) (props : QueueProps := {}) : Construct Kind AWS.Queue :=
  resource Kind.queue id props

abbrev Send (queue : AWS.Queue) : Access Kind := .on queue QueueOp.send
abbrev Receive (queue : AWS.Queue) : Access Kind := .on queue QueueOp.receive

variable {access : Access Kind} {ε : Type}

def sendMessage (queue : AWS.Queue) (body : String) [h : Has access (Send queue)] :
    Run access ε Unit :=
  Run.perform queue (QueueCall.sendMessage body) h

def receiveMessage (queue : AWS.Queue) [h : Has access (Receive queue)] :
    Run access ε (Option String) :=
  Run.perform queue QueueCall.receiveMessage h

end SQS

namespace Lambda

/-- A function. Its body declares what it uses and ends with what it serves. -/
def Function (id : String) (props : FunctionProps := {})
    (body : Construct Kind (Serve Kind.function)) : Construct Kind AWS.Function :=
  host Kind.function id props body

end Lambda

/-- A story's expectation: the function answers exactly this. -/
def responds (expected : Response) : Cloud.Response Kind.function → Bool :=
  fun (got : Response) => got == expected

/-! ## In memory -/

structure Memory where
  objects : List (String × Path × String) := []
  messages : List (String × String) := []
deriving DecidableEq, Repr

namespace Memory

def object (m : Memory) (bucket : AWS.Bucket) (key : Path) : Option String :=
  (m.objects.find? fun (id, k, _) => id == bucket.id && k == key).map (·.2.2)

def queued (m : Memory) (queue : AWS.Queue) : List String :=
  (m.messages.filter (·.1 == queue.id)).map (·.2)

end Memory

def simulate : {k : Kind} → Ref k → (c : Call k) → Memory → Reply c × Memory × List (Emitted Kind)
  | .bucket, bucket, .getObject key, m => (m.object bucket key, m, [])
  | .bucket, bucket, .putObject key body, m =>
    ((), { m with
        objects := (m.objects.filter fun (id, k, _) => !(id == bucket.id && k == key))
          ++ [(bucket.id, key, body)] },
      [⟨.bucket, bucket, .objectCreated key⟩])
  | .bucket, bucket, .listObjects, m =>
    ((m.objects.filter (·.1 == bucket.id)).map (·.2.1), m, [])
  | .queue, queue, .sendMessage body, m =>
    ((), { m with messages := m.messages ++ [(queue.id, body)] }, [])
  | .queue, queue, .receiveMessage, m =>
    match m.messages.find? (·.1 == queue.id) with
    | none => (none, m, [])
    | some message => (some message.2, { m with messages := m.messages.erase message }, [])

/-- AWS, in memory. -/
def InMemory : Sim Kind where
  State := Memory
  init := {}
  call := simulate

end Alchemy.AWS
