import Alchemy.Cloud.Effect

/-!
# Layer

A `Layer In Out` builds the services `Out` from the services `In`, and says
what access they need. Layers compose, and the access of the result is the
union of what its parts need, so a host's role is whatever its layers ask for.
-/

namespace Alchemy.Cloud

variable {K : Type} [Cloud K]

/-- Builds the services `Out` from the services `In`, given the access it needs. -/
structure Layer (In Out : Service K) where
  /-- The access the services need. -/
  needs : Access K := ∅
  /-- The services, for any access that includes what they need. -/
  build : {access : Access K} → needs ≤ access → In access → Out access

namespace Layer

variable {In Mid Out R T S : Service K}

/--
Building something with the services `In` at hand, under some access. A `do`
block: `let objects ← S3.GetObject bucket` takes a binding, and
`let jobs ← service JobStorage` any other service.
-/
abbrev Make (In : Service K) (access : Access K) := ReaderT (In access) Id

/-- One of the services at hand. -/
def service (S : Service K) [Uses In S] {access : Access K} : Make In access (S access) :=
  fun services => Uses.get services

/--
`Gives m S access`: in `m`, the service `S` can be asked for, and comes built
for `access`. It is what lets a binding be written as a step: `← S3.GetObject bucket`.
-/
class Gives (m : Type → Type) (S : Service K) (access : outParam (Access K)) where
  give : m (S access)

/-- A layer's block gives any service its dependencies include. -/
instance (S : Service K) [Uses In S] {access : Access K} : Gives (Make In access) S access :=
  ⟨service S⟩

/-- Services that need no access of their own: built from the services they are given. -/
def make (build : {access : Access K} → Make In access (Out access)) : Layer In Out where
  build _ services := build.run services

/-- A service built from one of the services available. -/
def over (S : Service K) [Uses In S] (build : {access : Access K} → S access → Out access) :
    Layer In Out :=
  make fun services => build (Uses.get services)

/-- Give a layer the services it needs. The result needs what both need. -/
def provide (layer : Layer Mid Out) (deps : Layer In Mid) : Layer In Out where
  needs := deps.needs ∪ layer.needs
  build le services :=
    layer.build (Access.le_trans (Access.le_union_right _ _) le)
      (deps.build (Access.le_trans (Access.le_union_left _ _) le) services)

/-- Services built from the services of another layer. They need what that layer needs. -/
def «from» (deps : Layer In Mid) (build : {access : Access K} → Make Mid access (Out access)) :
    Layer In Out where
  needs := deps.needs
  build le services := build.run (deps.build le services)

/-- Both layers' services. They need what both need. -/
def merge (a : Layer In R) (b : Layer In T) : Layer In (Both R T) where
  needs := a.needs ∪ b.needs
  build le services :=
    { left := a.build (Access.le_trans (Access.le_union_left _ _) le) services
      right := b.build (Access.le_trans (Access.le_union_right _ _) le) services }

/-- `a ++ b`: both layers' services. -/
@[default_instance] instance : HAppend (Layer In R) (Layer In T) (Layer In (Both R T)) := ⟨merge⟩

@[simp] theorem needs_merge (a : Layer In R) (b : Layer In T) :
    (a ++ b).needs = a.needs ∪ b.needs := rfl

@[simp] theorem needs_provide (layer : Layer Mid Out) (deps : Layer In Mid) :
    (layer.provide deps).needs = deps.needs ∪ layer.needs := rfl

/-- The services of a layer that needs no others, built with exactly the access it asks for. -/
def services (layer : Layer Nothing R) : R layer.needs :=
  layer.build (Access.le_refl _) ⟨⟩

end Layer

export Layer (service Gives)

/-- Run code with the services of a layer. It runs with the access the layer needs. -/
def Effect.provide {R : Service K} {ε α : Type} (effect : Effect R ε α) (layer : Layer Nothing R) :
    Run layer.needs ε α :=
  effect.run layer.services

end Alchemy.Cloud
