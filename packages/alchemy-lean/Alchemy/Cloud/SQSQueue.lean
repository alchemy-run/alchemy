import Alchemy.Cloud.Provider
import Distilled.AWS.Services.SQS

/-!
# An SQS queue, on the generated SDK

The provider calls the SQS operations distilled generates from AWS's own model
of the service. Every error each operation can return is matched by name, and
what the provider does is proved against a model of SQS.
-/

namespace Alchemy.AWS.Queue
open Alchemy.Cloud Distilled
open Distilled.AWS (SQS.QueueAttributeName)
open Distilled.AWS.SQS (QueueAttributeName)

structure Props where
  /-- First in, first out. Fixed when the queue is created. -/
  fifo : Bool := false
  /-- Seconds a received message stays hidden. -/
  visibilityTimeout : Nat := 30
deriving DecidableEq, Repr

abbrev Attributes := Dict QueueAttributeName String

/-- The attributes that can be changed on a queue that exists. -/
def mutable (props : Props) : Attributes :=
  ⟨[(.visibilityTimeout, toString props.visibilityTimeout)]⟩

/-- The attributes a queue is created with. -/
def desired (props : Props) : Attributes :=
  ⟨(mutable props).entries ++ if props.fifo then [(.fifoQueue, "true")] else []⟩

abbrev Calls := Eff AWS.SQS.api Failure

/-- Make the queue of this name exist with these properties, and give its URL. -/
def reconcile (name : String) (props : Props) : Calls String := do
  match ← AWS.SQS.getQueueUrl { queueName := name } with
  | .ok found =>
    let some url := found.queueUrl | throw "SQS gave no URL for the queue"
    match ← AWS.SQS.setQueueAttributes { queueUrl := url, attributes := mutable props } with
    | .ok () => return url
    | .error (.queueDoesNotExist _) => throw "the queue disappeared while it was being configured"
    | .error (.overLimit _) | .error (.requestThrottled _) => throw "SQS is throttling requests"
    | .error (.invalidAttributeName _) | .error (.invalidAttributeValue _) =>
      throw "SQS rejected the queue's attributes"
    | .error (.invalidAddress _) | .error (.invalidSecurity _) | .error (.unsupportedOperation _) =>
      throw "SQS refused the request"
  | .error (.queueDoesNotExist _) =>
    match ← AWS.SQS.createQueue { queueName := name, attributes := some (desired props) } with
    | .ok created =>
      let some url := created.queueUrl | throw "SQS gave no URL for the queue"
      return url
    | .error (.queueNameExists _) => throw "a queue of this name exists with other attributes"
    | .error (.queueDeletedRecently _) =>
      throw "a queue of this name was deleted less than a minute ago"
    | .error (.invalidAttributeName _) | .error (.invalidAttributeValue _) =>
      throw "SQS rejected the queue's attributes"
    | .error (.requestThrottled _) => throw "SQS is throttling requests"
    | .error (.invalidAddress _) | .error (.invalidSecurity _) | .error (.unsupportedOperation _) =>
      throw "SQS refused the request"
  | .error (.requestThrottled _) => throw "SQS is throttling requests"
  | .error (.invalidAddress _) | .error (.invalidSecurity _) | .error (.unsupportedOperation _) =>
    throw "SQS refused the request"

/-- Remove the queue of this name. One that is already gone counts as removed. -/
def delete (name : String) : Calls Unit := do
  match ← AWS.SQS.getQueueUrl { queueName := name } with
  | .error (.queueDoesNotExist _) => return
  | .error (.requestThrottled _) => throw "SQS is throttling requests"
  | .error (.invalidAddress _) | .error (.invalidSecurity _) | .error (.unsupportedOperation _) =>
    throw "SQS refused the request"
  | .ok found =>
    let some url := found.queueUrl | throw "SQS gave no URL for the queue"
    match ← AWS.SQS.deleteQueue { queueUrl := url } with
    | .ok () | .error (.queueDoesNotExist _) => return
    | .error (.requestThrottled _) => throw "SQS is throttling requests"
    | .error (.invalidAddress _) | .error (.invalidSecurity _) | .error (.unsupportedOperation _) =>
      throw "SQS refused the request"

/-- The physical name of an instance of a queue. A first-in-first-out queue's name must end in `.fifo`. -/
def nameOf (slot : Slot) (props : Props) : String :=
  s!"{slot.id}-{slot.generation}{if props.fifo then ".fifo" else ""}"

def provider : Provider AWS.SQS.api Props String where
  diff old new := if old = new then .noop else if old.fifo = new.fifo then .update else .replace
  reconcile slot props := reconcile (nameOf slot props) props
  delete slot := do
    -- the instance may have been made under either name
    delete (nameOf slot { fifo := false })
    delete (nameOf slot { fifo := true })

/-! ## A model of SQS -/

/-- The queues of an account, by name. In the model a queue's URL is its name. -/
structure Queues where
  byName : String → Option Attributes := fun _ => none

def Queues.put (q : Queues) (name : String) (value : Option Attributes) : Queues :=
  ⟨fun n => if n = name then value else q.byName n⟩

def step : (op : AWS.SQS.Op) → AWS.SQS.Input op → Queues →
    Except (AWS.SQS.Error op) (AWS.SQS.Output op) × Queues
  | .getQueueUrl, input, q =>
    match q.byName input.queueName with
    | some _ => (.ok { queueUrl := some input.queueName }, q)
    | none => (.error (.queueDoesNotExist {}), q)
  | .createQueue, input, q =>
    match q.byName input.queueName with
    | none => (.ok { queueUrl := some input.queueName },
        q.put input.queueName (some (input.attributes.getD {})))
    | some existing =>
      if existing = input.attributes.getD {} then (.ok { queueUrl := some input.queueName }, q)
      else (.error (.queueNameExists {}), q)
  | .setQueueAttributes, input, q =>
    match q.byName input.queueUrl with
    | some existing => (.ok (), q.put input.queueUrl
        (some (input.attributes.entries.foldl (fun d (k, v) => d.set k v) existing)))
    | none => (.error (.queueDoesNotExist {}), q)
  | .deleteQueue, input, q =>
    match q.byName input.queueUrl with
    | some _ => (.ok (), q.put input.queueUrl none)
    | none => (.error (.queueDoesNotExist {}), q)
  | op, _, q => (.ok (AWS.SQS.Output.empty op), q)

/-- SQS, as far as creating, configuring and removing queues goes. -/
def Service : Model AWS.SQS.api where
  State := Queues
  step := step

/-! ## What is proved -/

macro "run_sqs" : tactic =>
  `(tactic| simp only [reconcile, delete, AWS.SQS.getQueueUrl, AWS.SQS.createQueue,
      AWS.SQS.setQueueAttributes, AWS.SQS.deleteQueue, Eff.ask, Bind.bind, Eff.bind, Eff.run,
      Service, step, Pure.pure, throw] at *)

/--
A reconcile that succeeds leaves a queue of that name whose visibility timeout
is the one asked for, whatever was there before.
-/
theorem reconciled (name : String) (props : Props) (q q' : Queues) (url : String)
    (ok : (reconcile name props).run Service q = (.ok url, q')) :
    ∃ attributes, q'.byName name = some attributes ∧
      attributes.get? .visibilityTimeout = some (toString props.visibilityTimeout) := by
  run_sqs
  cases existing : q.byName name with
  | none =>
    simp [Eff.run, step, existing] at ok
    obtain ⟨_, rfl⟩ := ok
    refine ⟨desired props, by simp [Queues.put], ?_⟩
    simp [desired, mutable, Dict.get?]
  | some attributes =>
    simp [Eff.run, step, existing] at ok
    obtain ⟨_, rfl⟩ := ok
    refine ⟨attributes.set .visibilityTimeout (toString props.visibilityTimeout),
      by simp [Queues.put, mutable], Dict.get?_set _ _ _⟩

/-- However a reconcile ends, no queue of another name is created, changed or removed. -/
theorem reconcile_frame (name : String) (props : Props) (q : Queues) (other : String)
    (ne : other ≠ name) : ((reconcile name props).run Service q).2.byName other = q.byName other := by
  run_sqs
  cases existing : q.byName name <;> simp [Eff.run, step, existing, Queues.put, ne]

/-- A delete that succeeds leaves no queue of that name. -/
theorem deleted (name : String) (q q' : Queues)
    (ok : (delete name).run Service q = (.ok (), q')) : q'.byName name = none := by
  run_sqs
  cases existing : q.byName name <;> simp [Eff.run, step, existing] at ok <;> rw [← ok]
  · exact existing
  · simp [Queues.put]

end Alchemy.AWS.Queue
