import Alchemy.Cloud.Run

/-!
# Effect

`Effect R ε α` is code that needs the services `R`, may fail with `ε`, and
returns `α`. It does not name the access it runs with: a `Layer` supplies the
services, and with them the access they need.
-/

namespace Alchemy.Cloud

variable {K : Type} [Cloud K]

/--
A service is a type that depends on the access its code runs with: a structure
whose fields are functions into `Run access`.
-/
abbrev Service (K : Type) [Cloud K] := Access K → Type

/-- No services. -/
structure Nothing (access : Access K) : Type where

/-- Two sets of services together. -/
structure Both (R T : Service K) (access : Access K) : Type where
  left : R access
  right : T access

/-- `Uses R S`: the services `R` include the service `S`. Found by the shape of `R`. -/
class Uses (R S : Service K) where
  get : {access : Access K} → R access → S access

instance (S : Service K) : Uses S S := ⟨id⟩

instance (R T S : Service K) [Uses R S] : Uses (Both R T) S := ⟨fun both => Uses.get both.left⟩

instance (R T S : Service K) [Uses T S] : Uses (Both R T) S := ⟨fun both => Uses.get both.right⟩

/-- Code that needs the services `R`, may fail with `ε`, and returns `α`. -/
structure Effect (R : Service K) (ε α : Type) where
  /-- Run with these services, under whatever access they were built for. -/
  run : {access : Access K} → R access → Run access ε α

namespace Effect

variable {R T : Service K} {ε ε' α β : Type}

instance : Monad (Effect R ε) where
  pure a := ⟨fun _ => .pure a⟩
  bind effect f := ⟨fun services => (effect.run services).bind fun a => (f a).run services⟩

instance : MonadExcept ε (Effect R ε) where
  throw e := ⟨fun _ => .fail e⟩
  tryCatch effect handle :=
    ⟨fun services => (effect.run services).recover fun e => (handle e).run services⟩

/-- Recover from a failure, into code that may fail another way. -/
def recover (effect : Effect R ε α) (handle : ε → Effect R ε' α) : Effect R ε' α :=
  ⟨fun services => (effect.run services).recover fun e => (handle e).run services⟩

/-- The outcome as a value, so a failure can be matched on. -/
def result (effect : Effect R ε α) : Effect R ε' (Except ε α) :=
  ⟨fun services => (effect.run services).result⟩

def mapError (f : ε → ε') (effect : Effect R ε α) : Effect R ε' α :=
  ⟨fun services => (effect.run services).mapError f⟩

/-- Call a service: `use JobStorage (·.get id)`. -/
def use (S : Service K) [Uses R S] (f : {access : Access K} → S access → Run access ε α) :
    Effect R ε α :=
  ⟨fun services => f (Uses.get services)⟩

/-- Run code that needs fewer services where more are available. -/
def widen [Uses T R] (effect : Effect R ε α) : Effect T ε α :=
  ⟨fun services => effect.run (Uses.get services)⟩

end Effect

export Effect (use)

end Alchemy.Cloud
