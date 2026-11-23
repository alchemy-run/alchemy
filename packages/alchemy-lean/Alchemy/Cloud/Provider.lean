import Alchemy.Cloud.Graph
import Alchemy.Cloud.Api

/-!
# Resource providers

A provider says how one kind of resource is brought to match its configuration
and how it is removed. `Lawful` is what the engine needs to be true of the
providers it drives; it is proved against a model of the service.
-/

namespace Alchemy.Cloud
open Distilled (Api Eff Model)

/-- What it takes to move a resource from one configuration to another. -/
inductive Diff where
  /-- Nothing to do. -/
  | noop
  /-- It can be changed in place. -/
  | update
  /-- It cannot: a new one must replace it. -/
  | replace
deriving DecidableEq, Repr

/-- Which instance of a logical resource: replacing a resource makes its next generation. -/
structure Slot where
  id : String
  generation : Nat
deriving DecidableEq, Repr

/-- One physical resource in the cloud. -/
structure Physical (K : Type) where
  kind : K
  id : String
  generation : Nat
deriving DecidableEq, Repr

def Physical.slot {K : Type} (x : Physical K) : Slot := ⟨x.id, x.generation⟩

/-- How one kind of resource is managed. -/
structure Provider (api : Api) (Props Attrs : Type) where
  /-- What it takes to go from the old configuration to the new. -/
  diff : Props → Props → Diff
  /--
  Make the resource exist and match the configuration, whatever is there now:
  nothing, an older configuration, or a half-finished earlier attempt.
  -/
  reconcile : Slot → Props → Eff api Failure Attrs
  /-- Remove the resource. Removing one that is already gone succeeds. -/
  delete : Slot → Eff api Failure Unit

/-- A provider for every kind of a cloud. -/
structure Providers (K : Type) [Cloud K] (api : Api) where
  Attrs : K → Type
  provider : (k : K) → Provider api (Cloud.Props k) (Attrs k)

variable {K : Type} [Cloud K] {api : Api}

/-- What the engine relies on. Proved for a set of providers against a model of their service. -/
structure Lawful (ps : Providers K api) (m : Model api) where
  /-- Whether a physical resource exists. -/
  present : Physical K → m.State → Bool
  /-- A configuration needs nothing to become itself. -/
  diff_self : ∀ k (props : Cloud.Props k), (ps.provider k).diff props props = .noop
  /-- A reconcile that succeeds leaves the resource there. -/
  reconcile_ok : ∀ k slot props s attrs s',
    ((ps.provider k).reconcile slot props).run m s = (.ok attrs, s') →
      present ⟨k, slot.id, slot.generation⟩ s' = true
  /-- A reconcile, however it ends, creates and removes nothing else. -/
  reconcile_frame : ∀ k slot props s (y : Physical K), y ≠ ⟨k, slot.id, slot.generation⟩ →
    present y (((ps.provider k).reconcile slot props).run m s).2 = present y s
  /-- A delete that succeeds leaves the resource gone. -/
  delete_ok : ∀ k slot s s',
    ((ps.provider k).delete slot).run m s = (.ok (), s') →
      present ⟨k, slot.id, slot.generation⟩ s' = false
  /-- A delete, however it ends, creates and removes nothing else. -/
  delete_frame : ∀ k slot s (y : Physical K), y ≠ ⟨k, slot.id, slot.generation⟩ →
    present y (((ps.provider k).delete slot).run m s).2 = present y s

end Alchemy.Cloud
