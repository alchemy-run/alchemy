import Alchemy.Cloud.Cloudflare
import Alchemy.Cloud.Engine
import Alchemy.Cloud.Cli

/-!
# Cloudflare's control plane

Enough of it to plan and apply a stack of buckets, queues and Workers: each is
put, which creates it or brings it to the configuration asked for, and deleted.
A bucket's name may be another account's, and a queue with a consumer cannot be
deleted. The providers are proved lawful against this model, failures included,
so the engine's guarantees hold of a Cloudflare stack as they do of an AWS one.
-/

namespace Alchemy.Cloudflare.Control
open Alchemy.Cloud
open Distilled (Eff)

/-- The operations: put a resource of a kind, or delete one. -/
inductive Op where
  | put (kind : Kind)
  | delete (kind : Kind)
deriving DecidableEq, Repr

/-- Why a bucket could not be put. -/
inductive PutBucketError where
  /-- Another account has a bucket of this name. -/
  | nameTaken
deriving DecidableEq, Repr

/-- Why a resource could not be deleted. -/
inductive DeleteError where
  /-- There is no such resource. -/
  | notFound
  /-- A queue with a consumer cannot be deleted. -/
  | queueHasConsumer
deriving DecidableEq, Repr

abbrev Error : Op → Type
  | .put .bucket => PutBucketError
  | .put _ => Empty
  | .delete _ => DeleteError

/-- The control plane: every operation, with what it can fail with. -/
abbrev Api : Distilled.Api where
  Op := Op
  In := fun _ => Slot
  Out := fun _ => Unit
  Err := Error

/-- An account: which resources exist, and what stands in the way of some operations. -/
structure Account where
  exists_ : Physical Kind → Bool := fun _ => false
  /-- Bucket names another account has. -/
  taken : Slot → Bool := fun _ => false
  /-- Queues that still have a consumer attached. -/
  consumed : Slot → Bool := fun _ => false

def Account.created (a : Account) (kind : Kind) (slot : Slot) : Account :=
  { a with exists_ := fun y => y == ⟨kind, slot.id, slot.generation⟩ || a.exists_ y }

def Account.removed (a : Account) (kind : Kind) (slot : Slot) : Account :=
  { a with exists_ := fun y => !(y == ⟨kind, slot.id, slot.generation⟩) && a.exists_ y }

def step : (op : Op) → Slot → Account → Except (Error op) Unit × Account
  | .put .bucket, slot, a =>
    if a.taken slot then (.error .nameTaken, a) else (.ok (), a.created .bucket slot)
  | .put .queue, slot, a => (.ok (), a.created .queue slot)
  | .put .worker, slot, a => (.ok (), a.created .worker slot)
  | .delete kind, slot, a =>
    if !a.exists_ ⟨kind, slot.id, slot.generation⟩ then (.error .notFound, a)
    else if kind == .queue && a.consumed slot then (.error .queueHasConsumer, a)
    else (.ok (), a.removed kind slot)

/-- Cloudflare, as these providers need to understand it. -/
abbrev Service : Distilled.Model Api where
  State := Account
  step := step

abbrev Calls (α : Type) := Eff Api Failure α

/-- Put a resource. Only a bucket can be refused: its name may be another account's. -/
def reconcile : (kind : Kind) → Slot → Calls Slot
  | .bucket, slot => do
    match ← Eff.ask (api := Api) (.put .bucket) slot with
    | .ok () => return slot
    | .error .nameTaken => throw "the bucket name is taken by another account"
  | .queue, slot => do
    match ← Eff.ask (api := Api) (.put .queue) slot with
    | .ok () => return slot
  | .worker, slot => do
    match ← Eff.ask (api := Api) (.put .worker) slot with
    | .ok () => return slot

/-- Delete a resource. One that is already gone is deleted; a queue still consumed is not. -/
def delete (kind : Kind) (slot : Slot) : Calls Unit := do
  match ← Eff.ask (api := Api) (.delete kind) slot with
  | .ok () | .error .notFound => return
  | .error .queueHasConsumer => throw "the queue still has a consumer"

/-- Any of the three kinds: everything about it can be changed in place. -/
def provider (kind : Kind) : Provider Api (Cloud.Props kind) Slot where
  diff old new :=
    match kind, old, new with
    | .bucket, (old : BucketProps), (new : BucketProps) => if old = new then .noop else .update
    | .queue, (old : QueueProps), (new : QueueProps) => if old = new then .noop else .update
    | .worker, (old : WorkerProps), (new : WorkerProps) => if old = new then .noop else .update
  reconcile slot _ := reconcile kind slot
  delete slot := delete kind slot

def providers : Providers Kind Api where
  Attrs := fun _ => Slot
  provider := provider

/-- What putting a resource does to an account. -/
theorem reconcile_run (kind : Kind) (slot : Slot) (a : Account) :
    (reconcile kind slot).run Service a =
      if kind = .bucket ∧ a.taken slot = true
      then (.error "the bucket name is taken by another account", a)
      else (.ok slot, a.created kind slot) := by
  cases kind
  · cases taken : a.taken slot <;>
      simp [reconcile, Eff.ask, Bind.bind, Eff.bind, Eff.run, step, taken, Pure.pure, throw]
  · simp [reconcile, Eff.ask, Bind.bind, Eff.bind, Eff.run, step, Pure.pure]
  · simp [reconcile, Eff.ask, Bind.bind, Eff.bind, Eff.run, step, Pure.pure]

/-- What deleting a resource does to an account. -/
theorem delete_run (kind : Kind) (slot : Slot) (a : Account) :
    (delete kind slot).run Service a =
      if a.exists_ ⟨kind, slot.id, slot.generation⟩ = false then (.ok (), a)
      else if kind = .queue ∧ a.consumed slot = true
        then (.error "the queue still has a consumer", a)
        else (.ok (), a.removed kind slot) := by
  cases there : a.exists_ ⟨kind, slot.id, slot.generation⟩
  · simp [delete, Eff.ask, Bind.bind, Eff.bind, Eff.run, step, there, Pure.pure]
  · cases kind <;> cases busy : a.consumed slot <;>
      simp [delete, Eff.ask, Bind.bind, Eff.bind, Eff.run, step, there, busy, Pure.pure, throw]

/-- These providers meet what the engine relies on, against this model of Cloudflare. -/
def lawful : Lawful providers Service where
  present := fun y a => a.exists_ y
  diff_self := by intro k props; cases k <;> simp [providers, provider]
  reconcile_ok := by
    intro k slot props s attrs s' ok
    simp only [providers, provider, reconcile_run] at ok
    split at ok
    · cases ok
    · cases ok; simp [Account.created]
  reconcile_frame := by
    intro k slot props s y ne
    simp only [providers, provider, reconcile_run]
    split
    · rfl
    · simp [Account.created, ne]
  delete_ok := by
    intro k slot s s' ok
    simp only [providers, provider, delete_run] at ok
    split at ok
    · cases ok; assumption
    · split at ok
      · cases ok
      · cases ok; simp [Account.removed]
  delete_frame := by
    intro k slot s y ne
    simp only [providers, provider, delete_run]
    split
    · rfl
    · split
      · rfl
      · simp [Account.removed, ne]

end Alchemy.Cloudflare.Control

namespace Alchemy.Cloudflare
open Alchemy.Cloud

/-- A binding, in words. -/
def describeGrant : Attempt Kind → String
  | ⟨.bucket, bucket, .read⟩ => s!"read {bucket.id}"
  | ⟨.bucket, bucket, .write⟩ => s!"write {bucket.id}"
  | ⟨.queue, queue, .send⟩ => s!"send to {queue.id}"
  | ⟨.worker, worker, .call⟩ => s!"call {worker.id}"

/-- A resource's settings, by name. -/
def describeSettings : (k : Kind) → Cloud.Props k → List (String × String)
  | .bucket, _ => []
  | .queue, (props : QueueProps) => [("batchSize", toString props.batchSize)]
  | .worker, (props : WorkerProps) => [("compatibilityDate", props.compatibilityDate)]

/-- Run a stack from the command line, against an empty model of a Cloudflare account. -/
def cli {Out : Type} (stack : Stack Kind Out) (args : List String) : IO UInt32 :=
  stack.cli Control.providers (⟨.empty, {}⟩ : Cloud.World Kind Control.Service) describeGrant
    describeSettings args

end Alchemy.Cloudflare
