import Alchemy.Cloud.AWS
import Alchemy.Cloud.Engine

/-!
# The AWS control plane, in small

The operations that create, change and remove buckets, queues and functions,
each with the errors it can return; a model of what they do; and the providers
that drive them, with proofs.

In a real SDK this file's `Api` is generated from the service's own description.
-/

namespace Alchemy.AWS.Control
open Alchemy.Cloud
open Distilled (Api Eff Model)

/-! ## The API -/

inductive Op where
  | createBucket | headBucket | putBucketVersioning | getBucketVersioning | deleteBucket
  | createQueue | getQueueAttributes | setQueueAttributes | deleteQueue
  | createFunction | getFunctionConfiguration | updateFunctionConfiguration | deleteFunction
deriving DecidableEq, Repr

inductive CreateBucketError where
  /-- You already have this bucket. -/
  | bucketAlreadyOwnedByYou
  /-- Somebody else has this name. -/
  | bucketAlreadyExists
deriving DecidableEq, Repr

inductive HeadBucketError where
  | notFound
deriving DecidableEq, Repr

inductive BucketError where
  | noSuchBucket
deriving DecidableEq, Repr

inductive DeleteBucketError where
  | noSuchBucket
  | bucketNotEmpty
deriving DecidableEq, Repr

inductive CreateQueueError where
  /-- A queue with this name exists with other attributes. -/
  | queueNameExists
deriving DecidableEq, Repr

inductive QueueError where
  | queueDoesNotExist
deriving DecidableEq, Repr

inductive CreateFunctionError where
  | resourceConflict
deriving DecidableEq, Repr

inductive FunctionError where
  | resourceNotFound
deriving DecidableEq, Repr

abbrev Input : Op → Type
  | .createBucket | .headBucket | .getBucketVersioning | .deleteBucket => Slot
  | .putBucketVersioning => Slot × Bool
  | .createQueue => Slot × QueueProps
  | .setQueueAttributes => Slot × Nat
  | .getQueueAttributes | .deleteQueue => Slot
  | .createFunction | .updateFunctionConfiguration => Slot × FunctionProps
  | .getFunctionConfiguration | .deleteFunction => Slot

abbrev Output : Op → Type
  | .getBucketVersioning => Bool
  | .getQueueAttributes => QueueProps
  | .getFunctionConfiguration => FunctionProps
  | _ => Unit

abbrev Error : Op → Type
  | .createBucket => CreateBucketError
  | .headBucket => HeadBucketError
  | .putBucketVersioning | .getBucketVersioning => BucketError
  | .deleteBucket => DeleteBucketError
  | .createQueue => CreateQueueError
  | .getQueueAttributes | .setQueueAttributes | .deleteQueue => QueueError
  | .createFunction => CreateFunctionError
  | .getFunctionConfiguration | .updateFunctionConfiguration | .deleteFunction => FunctionError

/-- The control plane: every operation, with its input, output and errors. -/
abbrev Api : Distilled.Api where
  Op := Op
  In := Input
  Out := Output
  Err := Error

/-! ## What the service does -/

structure BucketState where
  versioned : Bool := false
  /-- How many objects it holds. A bucket that holds any cannot be deleted. -/
  objects : Nat := 0

/-- An AWS account, as far as these operations can tell. -/
structure Account where
  buckets : Slot → Option BucketState := fun _ => none
  /-- Bucket names somebody else has. -/
  taken : Slot → Bool := fun _ => false
  queues : Slot → Option QueueProps := fun _ => none
  functions : Slot → Option FunctionProps := fun _ => none

def put {α : Type} (map : Slot → Option α) (name : Slot) (value : Option α) : Slot → Option α :=
  fun n => if n = name then value else map n

@[simp] theorem put_self {α : Type} (map : Slot → Option α) (name : Slot) (value : Option α) :
    put map name value name = value := by simp [put]

theorem put_of_ne {α : Type} (map : Slot → Option α) {name other : Slot} (value : Option α)
    (ne : other ≠ name) : put map name value other = map other := by simp [put, ne]

def step : (op : Op) → Input op → Account → Except (Error op) (Output op) × Account
  | .createBucket, name, a =>
    if a.taken name then (.error .bucketAlreadyExists, a)
    else match a.buckets name with
      | some _ => (.error .bucketAlreadyOwnedByYou, a)
      | none => (.ok (), { a with buckets := put a.buckets name (some {}) })
  | .headBucket, name, a =>
    match a.buckets name with
    | some _ => (.ok (), a)
    | none => (.error .notFound, a)
  | .putBucketVersioning, (name, versioned), a =>
    match a.buckets name with
    | some bucket => (.ok (), { a with buckets := put a.buckets name (some { bucket with versioned }) })
    | none => (.error .noSuchBucket, a)
  | .getBucketVersioning, name, a =>
    match a.buckets name with
    | some bucket => (.ok bucket.versioned, a)
    | none => (.error .noSuchBucket, a)
  | .deleteBucket, name, a =>
    match a.buckets name with
    | none => (.error .noSuchBucket, a)
    | some bucket =>
      if bucket.objects = 0 then (.ok (), { a with buckets := put a.buckets name none })
      else (.error .bucketNotEmpty, a)
  | .createQueue, (name, props), a =>
    match a.queues name with
    | none => (.ok (), { a with queues := put a.queues name (some props) })
    | some existing => if existing = props then (.ok (), a) else (.error .queueNameExists, a)
  | .getQueueAttributes, name, a =>
    match a.queues name with
    | some queue => (.ok queue, a)
    | none => (.error .queueDoesNotExist, a)
  | .setQueueAttributes, (name, visibilityTimeout), a =>
    match a.queues name with
    | some queue =>
      (.ok (), { a with queues := put a.queues name (some { queue with visibilityTimeout }) })
    | none => (.error .queueDoesNotExist, a)
  | .deleteQueue, name, a =>
    match a.queues name with
    | some _ => (.ok (), { a with queues := put a.queues name none })
    | none => (.error .queueDoesNotExist, a)
  | .createFunction, (name, props), a =>
    match a.functions name with
    | none => (.ok (), { a with functions := put a.functions name (some props) })
    | some _ => (.error .resourceConflict, a)
  | .getFunctionConfiguration, name, a =>
    match a.functions name with
    | some function => (.ok function, a)
    | none => (.error .resourceNotFound, a)
  | .updateFunctionConfiguration, (name, props), a =>
    match a.functions name with
    | some _ => (.ok (), { a with functions := put a.functions name (some props) })
    | none => (.error .resourceNotFound, a)
  | .deleteFunction, name, a =>
    match a.functions name with
    | some _ => (.ok (), { a with functions := put a.functions name none })
    | none => (.error .resourceNotFound, a)

/-- AWS, as these providers need to understand it. -/
def Service : Model Api where
  State := Account
  step := step

/-! ## The providers -/

abbrev Calls (α : Type) := Eff Api Failure α

def call (op : Op) (input : Input op) : Calls (Except (Error op) (Output op)) :=
  Eff.ask (api := Api) op input

/-- A bucket. Versioning can be changed in place. -/
def BucketProvider : Provider Api BucketProps Slot where
  diff old new := if old = new then .noop else .update
  reconcile name props := do
    -- observe, and create it if it is missing; losing a race to our own create is fine
    match ← call .headBucket name with
    | .ok () => pure ()
    | .error .notFound =>
      match ← call .createBucket name with
      | .ok () | .error .bucketAlreadyOwnedByYou => pure ()
      | .error .bucketAlreadyExists => throw "the bucket name is taken by another account"
    -- sync
    match ← call .putBucketVersioning (name, props.versioned) with
    | .ok () => return name
    | .error .noSuchBucket => throw "the bucket disappeared while it was being configured"
  delete name := do
    match ← call .deleteBucket name with
    | .ok () | .error .noSuchBucket => return
    | .error .bucketNotEmpty => throw "the bucket still holds objects"

/-- A queue. Whether it is first-in-first-out is fixed at creation. -/
def QueueProvider : Provider Api QueueProps Slot where
  diff old new :=
    if old = new then .noop else if old.fifo = new.fifo then .update else .replace
  reconcile name props := do
    match ← call .getQueueAttributes name with
    | .error .queueDoesNotExist =>
      match ← call .createQueue (name, props) with
      | .ok () => return name
      | .error .queueNameExists => throw "a queue with this name was created with other attributes"
    | .ok current =>
      if current.fifo ≠ props.fifo then
        throw "a queue cannot change whether it is first-in-first-out"
      else
        match ← call .setQueueAttributes (name, props.visibilityTimeout) with
        | .ok () => return name
        | .error .queueDoesNotExist => throw "the queue disappeared while it was being configured"
  delete name := do
    match ← call .deleteQueue name with
    | .ok () | .error .queueDoesNotExist => return

/-- A function. Everything about it can be changed in place. -/
def FunctionProvider : Provider Api FunctionProps Slot where
  diff old new := if old = new then .noop else .update
  reconcile name props := do
    match ← call .getFunctionConfiguration name with
    | .error .resourceNotFound =>
      match ← call .createFunction (name, props) with
      | .ok () => return name
      | .error .resourceConflict => throw "the function was created by something else meanwhile"
    | .ok _ =>
      match ← call .updateFunctionConfiguration (name, props) with
      | .ok () => return name
      | .error .resourceNotFound => throw "the function disappeared while it was being configured"
  delete name := do
    match ← call .deleteFunction name with
    | .ok () | .error .resourceNotFound => return

/-- A provider for every kind. -/
def providers : Providers Kind Api where
  Attrs := fun _ => Slot
  provider := fun
    | .bucket => BucketProvider
    | .queue => QueueProvider
    | .function => FunctionProvider

/-! ## The providers are lawful -/

set_option linter.unusedSimpArgs false

/-- Whether a physical resource exists in the account. -/
def present : Physical Kind → Account → Bool
  | ⟨.bucket, id, generation⟩, a => (a.buckets ⟨id, generation⟩).isSome
  | ⟨.queue, id, generation⟩, a => (a.queues ⟨id, generation⟩).isSome
  | ⟨.function, id, generation⟩, a => (a.functions ⟨id, generation⟩).isSome

/-- Unfolds a provider's code running against the model, down to lookups in the account. -/
macro "run_provider" : tactic =>
  `(tactic| simp only [providers, BucketProvider, QueueProvider, FunctionProvider, call, Eff.ask,
      Bind.bind, Eff.bind, Eff.run, Service, step, Pure.pure, throw, present, Physical.slot] at *)

/-- A bucket reconcile that succeeds leaves the bucket there, with the versioning asked for. -/
theorem bucket_reconciled (name : Slot) (props : BucketProps) (a a' : Account) (attrs : Slot)
    (ok : (BucketProvider.reconcile name props).run Service a = (.ok attrs, a')) :
    ∃ bucket, a'.buckets name = some bucket ∧ bucket.versioned = props.versioned := by
  run_provider
  cases bucket : a.buckets name <;> cases taken : a.taken name <;>
    simp [Eff.run, step, bucket, taken, put] at ok <;> (obtain ⟨_, rfl⟩ := ok) <;> simp [put]

/-- However a bucket reconcile ends, it touches no other bucket, no queue and no function. -/
theorem bucket_reconcile_frame (name : Slot) (props : BucketProps) (a : Account) :
    let a' := ((BucketProvider.reconcile name props).run Service a).2
    (∀ other, other ≠ name → a'.buckets other = a.buckets other) ∧
      a'.queues = a.queues ∧ a'.functions = a.functions := by
  run_provider
  cases bucket : a.buckets name <;> cases taken : a.taken name <;>
    simp [Eff.run, step, bucket, taken, put] <;> grind

/-- A bucket delete that succeeds leaves the bucket gone, whether it was there or not. -/
theorem bucket_deleted (name : Slot) (a a' : Account)
    (ok : (BucketProvider.delete name).run Service a = (.ok (), a')) : a'.buckets name = none := by
  run_provider
  cases bucket : a.buckets name with
  | none => simp [Eff.run, bucket] at ok; rw [← ok]; exact bucket
  | some held =>
    by_cases empty : held.objects = 0 <;> simp [Eff.run, bucket, empty] at ok
    rw [← ok]; simp

theorem bucket_delete_frame (name : Slot) (a : Account) :
    let a' := ((BucketProvider.delete name).run Service a).2
    (∀ other, other ≠ name → a'.buckets other = a.buckets other) ∧
      a'.queues = a.queues ∧ a'.functions = a.functions := by
  run_provider
  cases bucket : a.buckets name with
  | none => simp [Eff.run, bucket]
  | some held =>
    by_cases empty : held.objects = 0 <;> simp [Eff.run, bucket, empty]
    intro other ne; simp [put, ne]

/-- A queue reconcile that succeeds leaves the queue there, configured as asked. -/
theorem queue_reconciled (name : Slot) (props : QueueProps) (a a' : Account) (attrs : Slot)
    (ok : (QueueProvider.reconcile name props).run Service a = (.ok attrs, a')) :
    a'.queues name = some props := by
  run_provider
  cases queue : a.queues name <;> simp [Eff.run, step, queue] at ok
  · rw [← ok.2]; simp
  · split at ok <;> simp [Eff.run, step, queue] at ok
    rw [← ok.2]
    simp
    cases props; cases ‹QueueProps›; simp_all

theorem queue_reconcile_frame (name : Slot) (props : QueueProps) (a : Account) :
    let a' := ((QueueProvider.reconcile name props).run Service a).2
    (∀ other, other ≠ name → a'.queues other = a.queues other) ∧
      a'.buckets = a.buckets ∧ a'.functions = a.functions := by
  run_provider
  cases queue : a.queues name <;> simp [Eff.run, step, queue, put]
  · grind
  · split <;> simp [Eff.run, step, queue, put] <;> grind

theorem queue_deleted (name : Slot) (a a' : Account)
    (ok : (QueueProvider.delete name).run Service a = (.ok (), a')) : a'.queues name = none := by
  run_provider
  cases queue : a.queues name <;> simp [Eff.run, step, queue] at ok <;> rw [← ok] <;> simp [queue]

theorem queue_delete_frame (name : Slot) (a : Account) :
    let a' := ((QueueProvider.delete name).run Service a).2
    (∀ other, other ≠ name → a'.queues other = a.queues other) ∧
      a'.buckets = a.buckets ∧ a'.functions = a.functions := by
  run_provider
  cases queue : a.queues name <;> simp [Eff.run, step, queue, put] <;> grind

/-- A function reconcile that succeeds leaves the function there, configured as asked. -/
theorem function_reconciled (name : Slot) (props : FunctionProps) (a a' : Account) (attrs : Slot)
    (ok : (FunctionProvider.reconcile name props).run Service a = (.ok attrs, a')) :
    a'.functions name = some props := by
  run_provider
  cases function : a.functions name <;> simp [Eff.run, step, function] at ok <;>
    rw [← ok.2] <;> simp

theorem function_reconcile_frame (name : Slot) (props : FunctionProps) (a : Account) :
    let a' := ((FunctionProvider.reconcile name props).run Service a).2
    (∀ other, other ≠ name → a'.functions other = a.functions other) ∧
      a'.buckets = a.buckets ∧ a'.queues = a.queues := by
  run_provider
  cases function : a.functions name <;> simp [Eff.run, step, function, put] <;> grind

theorem function_deleted (name : Slot) (a a' : Account)
    (ok : (FunctionProvider.delete name).run Service a = (.ok (), a')) :
    a'.functions name = none := by
  run_provider
  cases function : a.functions name <;> simp [Eff.run, step, function] at ok <;>
    rw [← ok] <;> simp [function]

theorem function_delete_frame (name : Slot) (a : Account) :
    let a' := ((FunctionProvider.delete name).run Service a).2
    (∀ other, other ≠ name → a'.functions other = a.functions other) ∧
      a'.buckets = a.buckets ∧ a'.queues = a.queues := by
  run_provider
  cases function : a.functions name <;> simp [Eff.run, step, function, put] <;> grind

/-- These providers meet what the engine relies on, against this model of AWS. -/
def lawful : Lawful providers Service where
  present := present
  diff_self := by
    intro k props
    cases k <;> simp [providers, BucketProvider, QueueProvider, FunctionProvider]
  reconcile_ok := by
    intro k slot props s attrs s' ok
    cases k
    · obtain ⟨_, here, _⟩ := bucket_reconciled slot props s s' attrs ok
      simp [present, here]
    · simp [present, queue_reconciled slot props s s' attrs ok]
    · simp [present, function_reconciled slot props s s' attrs ok]
  reconcile_frame := by
    intro k slot props s y ne
    cases k
    · obtain ⟨buckets, queues, functions⟩ := bucket_reconcile_frame slot props s
      obtain ⟨_ | _ | _, id, generation⟩ := y <;> simp only [present, providers, queues, functions]
      rw [buckets]; intro same; cases same; exact ne rfl
    · obtain ⟨queues, buckets, functions⟩ := queue_reconcile_frame slot props s
      obtain ⟨_ | _ | _, id, generation⟩ := y <;> simp only [present, providers, buckets, functions]
      rw [queues]; intro same; cases same; exact ne rfl
    · obtain ⟨functions, buckets, queues⟩ := function_reconcile_frame slot props s
      obtain ⟨_ | _ | _, id, generation⟩ := y <;> simp only [present, providers, buckets, queues]
      rw [functions]; intro same; cases same; exact ne rfl
  delete_ok := by
    intro k slot s s' ok
    cases k
    · simp [present, bucket_deleted slot s s' ok]
    · simp [present, queue_deleted slot s s' ok]
    · simp [present, function_deleted slot s s' ok]
  delete_frame := by
    intro k slot s y ne
    cases k
    · obtain ⟨buckets, queues, functions⟩ := bucket_delete_frame slot s
      obtain ⟨_ | _ | _, id, generation⟩ := y <;> simp only [present, providers, queues, functions]
      rw [buckets]; intro same; cases same; exact ne rfl
    · obtain ⟨queues, buckets, functions⟩ := queue_delete_frame slot s
      obtain ⟨_ | _ | _, id, generation⟩ := y <;> simp only [present, providers, buckets, functions]
      rw [queues]; intro same; cases same; exact ne rfl
    · obtain ⟨functions, buckets, queues⟩ := function_delete_frame slot s
      obtain ⟨_ | _ | _, id, generation⟩ := y <;> simp only [present, providers, buckets, queues]
      rw [functions]; intro same; cases same; exact ne rfl

end Alchemy.AWS.Control

namespace Alchemy.AWS
open Alchemy.Cloud

/-- A grant, in words. -/
def describeGrant : Attempt Kind → String
  | ⟨.bucket, bucket, .get under⟩ => s!"read {bucket.id}/{"/".intercalate under}"
  | ⟨.bucket, bucket, .put under⟩ => s!"write {bucket.id}/{"/".intercalate under}"
  | ⟨.bucket, bucket, .list⟩ => s!"list {bucket.id}"
  | ⟨.queue, queue, .send⟩ => s!"send to {queue.id}"
  | ⟨.queue, queue, .receive⟩ => s!"receive from {queue.id}"
  | ⟨.function, function, .invoke⟩ => s!"invoke {function.id}"

end Alchemy.AWS
