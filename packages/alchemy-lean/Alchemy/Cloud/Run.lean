import Alchemy.Cloud.Access

/-!
# Run

Code that runs inside a host. Its type names the access it runs with, and every
call it makes carries the proof that this access permits it.
-/

namespace Alchemy.Cloud

/-- A cloud: its kinds of resource, how each is configured, called and listened to. -/
class Cloud (K : Type) extends Kinds K where
  /-- How a resource of this kind is configured. -/
  Props : K → Type
  /-- What running code can ask of a resource of this kind. -/
  Call : K → Type
  /-- What a call answers. -/
  Reply : {k : K} → Call k → Type
  /-- The access a call needs. -/
  needs : {k : K} → Call k → Op k
  /-- What a resource of this kind tells its subscribers. -/
  Event : K → Type
  /-- What a host of this kind is asked, and what it answers. -/
  Request : K → Type
  Response : K → Type
  /-- The resources a configuration refers to, by id. -/
  refs : {k : K} → Props k → List String := fun _ => []

variable {K : Type} [Cloud K]

/-- A computation that runs with `access`, may fail with `ε`, and returns `α`. -/
inductive Run (access : Access K) (ε α : Type) : Type where
  | pure (a : α)
  | fail (e : ε)
  /-- Ask a resource something. `ok` is the proof that `access` permits it. -/
  | call {k : K} (ref : Ref k) (c : Cloud.Call k)
      (ok : access.permits ⟨k, ref, Cloud.needs c⟩ = true)
      (next : Cloud.Reply c → Run access ε α)

namespace Run

variable {access : Access K} {ε ε' α β : Type}

def bind : Run access ε α → (α → Run access ε β) → Run access ε β
  | .pure a, f => f a
  | .fail e, _ => .fail e
  | .call ref c ok next, f => .call ref c ok fun reply => (next reply).bind f

instance : Monad (Run access ε) where
  pure := .pure
  bind := Run.bind

/-- Recover from a failure. -/
def recover : Run access ε α → (ε → Run access ε' α) → Run access ε' α
  | .pure a, _ => .pure a
  | .fail e, f => f e
  | .call ref c ok next, f => .call ref c ok fun reply => (next reply).recover f

instance : MonadExcept ε (Run access ε) where
  throw := .fail
  tryCatch := Run.recover

/-- The outcome as a value, so a failure can be matched on. -/
def result (run : Run access ε α) : Run access ε' (Except ε α) :=
  (run.bind fun a => (.pure (.ok a) : Run access ε (Except ε α))).recover fun e => .pure (.error e)

def mapError (f : ε → ε') (run : Run access ε α) : Run access ε' α :=
  run.recover fun e => .fail (f e)

/-- Run with more access than needed. -/
def weaken {more : Access K} (le : access ≤ more) : Run access ε α → Run more ε α
  | .pure a => .pure a
  | .fail e => .fail e
  | .call ref c ok next => .call ref c (le _ ok) fun reply => (next reply).weaken le

/-- Ask a resource something. The access must include what the call needs. -/
def perform {k : K} (ref : Ref k) (c : Cloud.Call k)
    (h : Has access (.on ref (Cloud.needs c))) : Run access ε (Cloud.Reply c) :=
  .call ref c h.permits .pure

/-- Ask a resource something under a wider grant that covers it, such as a key under a prefix. -/
def performUnder {k : K} (ref : Ref k) (c : Cloud.Call k) (granted : Kinds.Op k)
    (h : Has access (.on ref granted))
    (covered : (granted == Cloud.needs c || Kinds.covers granted (Cloud.needs c)) = true) :
    Run access ε (Cloud.Reply c) :=
  .call ref c (h.permits_covered covered) .pure

/-- Run against the real thing, given how to make each call. -/
def io (make : {k : K} → Ref k → (c : Cloud.Call k) → IO (Cloud.Reply c)) :
    Run access ε α → IO (Except ε α)
  | .pure a => return .ok a
  | .fail e => return .error e
  | .call ref c _ next => do (next (← make ref c)).io make

end Run

end Alchemy.Cloud
