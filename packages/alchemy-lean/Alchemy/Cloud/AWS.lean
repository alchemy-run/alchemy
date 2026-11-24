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

/-- A bucket has no object of this key. -/
structure S3.NoSuchKey where
  bucket : String
  key : Path
deriving DecidableEq, Repr

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
  | .getObject _ => Except S3.NoSuchKey String
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

variable {R : Service Kind} {ε : Type}

/-- How reading an object can fail. -/
inductive GetObjectError where
  | noSuchKey (error : NoSuchKey)
deriving DecidableEq, Repr

/-- Reads the objects of a bucket under a prefix. -/
structure GetObject (bucket : AWS.Bucket) (under : Path) (access : Access Kind) where
  call : String → Run access GetObjectError String

/-- Writes the objects of a bucket under a prefix. -/
structure PutObject (bucket : AWS.Bucket) (under : Path) (access : Access Kind) where
  call : String → String → Run access Never Unit

/-- Lists the keys of a bucket. -/
structure ListObjects (bucket : AWS.Bucket) (access : Access Kind) where
  call : Run access Never (_root_.List Path)

/-- `GetObject` on the bucket itself. Grants read access to the prefix. -/
def GetObjectLive (bucket : AWS.Bucket) (under : Path := []) :
    Layer Nothing (GetObject bucket under) where
  needs := Get bucket under
  build le _ :=
    { call := fun name => do
        let found ← Run.performUnder bucket (BucketCall.getObject (under ++ [name]))
          (BucketOp.get under) ⟨le⟩ (by simp [Cloud.needs, AWS.needs, Kinds.covers, BucketOp.covers])
        match found with
        | .ok body => return body
        | .error missing => throw (.noSuchKey missing) }

/-- `PutObject` on the bucket itself. Grants write access to the prefix. -/
def PutObjectLive (bucket : AWS.Bucket) (under : Path := []) :
    Layer Nothing (PutObject bucket under) where
  needs := Put bucket under
  build le _ :=
    { call := fun name body =>
        Run.performUnder bucket (BucketCall.putObject (under ++ [name]) body) (BucketOp.put under)
          ⟨le⟩ (by simp [Cloud.needs, AWS.needs, Kinds.covers, BucketOp.covers]) }

/-- `ListObjects` on the bucket itself. Grants listing its keys. -/
def ListObjectsLive (bucket : AWS.Bucket) : Layer Nothing (ListObjects bucket) where
  needs := List bucket
  build le _ := { call := Run.perform bucket BucketCall.listObjects ⟨le⟩ }

/-- Read `under/name`. -/
def getObject (bucket : AWS.Bucket) (under : Path) (name : String)
    [Uses R (GetObject bucket under)] [Raises ε GetObjectError] : Effect R ε String :=
  use (GetObject bucket under) (·.call name)

/-- Write `under/name`. -/
def putObject (bucket : AWS.Bucket) (under : Path) (name : String) (body : String)
    [Uses R (PutObject bucket under)] : Effect R ε Unit :=
  use (PutObject bucket under) (·.call name body)

def listObjects (bucket : AWS.Bucket) [Uses R (ListObjects bucket)] :
    Effect R ε (_root_.List Path) :=
  use (ListObjects bucket) (·.call)

/-- Run this whenever an object is created in the bucket. -/
def onObjectCreated {ε : Type} [Repr ε] (bucket : AWS.Bucket)
    (handle : Path → Effect R ε Unit) : Listener R where
  kind := .bucket
  source := bucket
  Error := ε
  describe := reprStr
  handle := fun
    | .objectCreated key => handle key

end S3

namespace SQS

def Queue (id : String) (props : QueueProps := {}) : Construct Kind AWS.Queue :=
  resource Kind.queue id props

abbrev Send (queue : AWS.Queue) : Access Kind := .on queue QueueOp.send
abbrev Receive (queue : AWS.Queue) : Access Kind := .on queue QueueOp.receive

variable {R : Service Kind} {ε : Type}

/-- Sends messages to a queue. -/
structure SendMessage (queue : AWS.Queue) (access : Access Kind) where
  call : String → Run access Never Unit

/-- Takes messages off a queue. -/
structure ReceiveMessage (queue : AWS.Queue) (access : Access Kind) where
  call : Run access Never (Option String)

/-- `SendMessage` on the queue itself. Grants sending to it. -/
def SendMessageLive (queue : AWS.Queue) : Layer Nothing (SendMessage queue) where
  needs := Send queue
  build le _ := { call := fun body => Run.perform queue (QueueCall.sendMessage body) ⟨le⟩ }

/-- `ReceiveMessage` on the queue itself. Grants receiving from it. -/
def ReceiveMessageLive (queue : AWS.Queue) : Layer Nothing (ReceiveMessage queue) where
  needs := Receive queue
  build le _ := { call := Run.perform queue QueueCall.receiveMessage ⟨le⟩ }

def sendMessage (queue : AWS.Queue) (body : String) [Uses R (SendMessage queue)] :
    Effect R ε Unit :=
  use (SendMessage queue) (·.call body)

def receiveMessage (queue : AWS.Queue) [Uses R (ReceiveMessage queue)] :
    Effect R ε (Option String) :=
  use (ReceiveMessage queue) (·.call)

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

def simulate : {k : Kind} → Ref k → (c : Call k) → Memory → Reply c × Memory × List (Cloud.Emitted Kind)
  | .bucket, bucket, .getObject key, m =>
    (match m.object bucket key with
      | some body => .ok body
      | none => .error { bucket := bucket.id, key }, m, [])
  | .bucket, bucket, .putObject key body, m =>
    ((), { m with
        objects := (m.objects.filter fun (id, k, _) => !(id == bucket.id && k == key))
          ++ [(bucket.id, key, body)] },
      [(⟨.bucket, bucket, .objectCreated key⟩ : Cloud.Emitted Kind)])
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
