import Alchemy.Cloud.Cloudflare
import Alchemy.Cloud.Engine
import Alchemy.Cloud.Cli

/-!
# Cloudflare's control plane

Enough of it to plan and apply a stack of buckets, queues and Workers: each is
put, which creates it or brings it to the configuration asked for, and deleted.
The providers are proved lawful against this model, so the engine's guarantees
hold of a Cloudflare stack as they do of an AWS one.
-/

namespace Alchemy.Cloudflare.Control
open Alchemy.Cloud
open Distilled (Eff)

/-- The operations: put a resource of a kind, or delete one. -/
inductive Op where
  | put (kind : Kind)
  | delete (kind : Kind)
deriving DecidableEq, Repr

/-- The control plane. Putting is an upsert and deleting is idempotent, so neither fails. -/
abbrev Api : Distilled.Api where
  Op := Op
  In := fun _ => Slot
  Out := fun _ => Unit
  Err := fun _ => Empty

/-- An account: which resources exist. -/
structure Account where
  exists_ : Physical Kind → Bool := fun _ => false

def step : (op : Op) → Slot → Account → Except Empty Unit × Account
  | .put kind, slot, a =>
    (.ok (), { exists_ := fun y => y == ⟨kind, slot.id, slot.generation⟩ || a.exists_ y })
  | .delete kind, slot, a =>
    (.ok (), { exists_ := fun y => !(y == ⟨kind, slot.id, slot.generation⟩) && a.exists_ y })

/-- Cloudflare, as these providers need to understand it. -/
def Service : Distilled.Model Api where
  State := Account
  step := step

/-- Any of the three kinds: everything about it can be changed in place. -/
def provider (kind : Kind) : Provider Api (Cloud.Props kind) Slot where
  diff old new :=
    match kind, old, new with
    | .bucket, (old : BucketProps), (new : BucketProps) => if old = new then .noop else .update
    | .queue, (old : QueueProps), (new : QueueProps) => if old = new then .noop else .update
    | .worker, (old : WorkerProps), (new : WorkerProps) => if old = new then .noop else .update
  reconcile slot _ := do
    let _ ← Eff.ask (api := Api) (.put kind) slot
    return slot
  delete slot := do
    let _ ← Eff.ask (api := Api) (.delete kind) slot
    return

def providers : Providers Kind Api where
  Attrs := fun _ => Slot
  provider := provider

/-- These providers meet what the engine relies on, against this model of Cloudflare. -/
def lawful : Lawful providers Service where
  present := fun y a => a.exists_ y
  diff_self := by intro k props; cases k <;> simp [providers, provider]
  reconcile_ok := by
    intro k slot props s attrs s' ok
    simp only [providers, provider, Eff.ask, Bind.bind, Eff.bind, Eff.run, Service, step,
      Pure.pure] at ok
    cases ok
    simp
  reconcile_frame := by
    intro k slot props s y ne
    simp only [providers, provider, Eff.ask, Bind.bind, Eff.bind, Eff.run, Service, step, Pure.pure]
    simp [ne]
  delete_ok := by
    intro k slot s s' ok
    simp only [providers, provider, Eff.ask, Bind.bind, Eff.bind, Eff.run, Service, step,
      Pure.pure] at ok
    cases ok
    simp
  delete_frame := by
    intro k slot s y ne
    simp only [providers, provider, Eff.ask, Bind.bind, Eff.bind, Eff.run, Service, step, Pure.pure]
    simp [ne]

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
