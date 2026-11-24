import Alchemy.Cloud.Sim

/-!
# A host's body

`Host role` is the `do` block a host is written in. A binding is a step: it
adds a grant to the host's role and gives back a client. Listening to a
resource is a step too: it registers the listener. The block ends with what the
host serves.

Nobody writes the role. The block is run when the stack is built, and its role
is the grants its steps asked for.
-/

namespace Alchemy.Cloud

variable {K : Type} [Cloud K]

/-- Whether an expression contains this very grant. -/
def Access.holds (role : Access K) (grant : Attempt K) : Bool :=
  role.atoms.any fun atom =>
    if h : atom.kind = grant.kind then (h ▸ atom.ref) == grant.ref && (h ▸ atom.op) == grant.op
    else false

/-- Whether an expression contains every grant of another. -/
def Access.covers (role need : Access K) : Bool := need.atoms.all role.holds

theorem Access.le_of_covers {role need : Access K} (covers : role.covers need = true) :
    need ≤ role := by
  intro t permitted
  rw [Access.permits_iff_atom] at permitted ⊢
  obtain ⟨grant, mem, on⟩ := permitted
  have held := List.all_eq_true.mp covers grant mem
  obtain ⟨atom, atomMem, same⟩ := List.any_eq_true.mp held
  obtain ⟨kind, ref, op⟩ := atom
  obtain ⟨kind', ref', op'⟩ := grant
  split at same
  · next h =>
    cases h
    simp only [Bool.and_eq_true, beq_iff_eq] at same
    obtain ⟨rfl, rfl⟩ := same
    exact ⟨_, atomMem, on⟩
  · cases same

/-- Both, leaving out an empty left side. -/
def Access.join : Access K → Access K → Access K
  | .none, more => more
  | role, more => role ∪ more

/-- What a host's block has said so far: what it listens to, and where it asks for each grant. -/
structure Hosting (role : Access K) where
  on : List (Subscription role) := []
  sites : List (Access K × String) := []

/--
The `do` block of a host that runs with `role`. A step that needs a grant the
role lacks stops the block with that grant, and the block is run again with it.
-/
abbrev Host (role : Access K) :=
  StateT (Hosting role) (ExceptT (Access K) (Construct K))

namespace Host

variable {role : Access K}

/-- Ask for a grant. Gives the proof that the role includes it. -/
def grant (need : Access K) : Host role (PLift (need ≤ role)) :=
  if covers : role.covers need = true then pure ⟨Access.le_of_covers covers⟩
  else throwThe (Access K) need

/-- The services of a layer, with what it needs added to the role. -/
def provide {R : Service K} (layer : Layer Nothing R) : Host role (R role) := do
  let ⟨le⟩ ← grant layer.needs
  return layer.build le ⟨⟩

/-- Note where grants are asked for. -/
def note (sites : List (Access K × String)) : Host role Unit :=
  modify fun hosting => { hosting with sites := hosting.sites ++ sites }

/-- Register a listener. -/
def listen (subscription : Subscription role) : Host role Unit :=
  modify fun hosting => { hosting with on := hosting.on ++ [subscription] }

end Host

/-- `Live S`: the service `S` on the resource itself, and the grant that takes. -/
class Live (S : Service K) where
  layer : Layer Nothing S

/-- A host's block gives any binding, and adds its grant to the role. -/
instance (S : Service K) [Live S] {role : Access K} : Gives (Host role) S role :=
  ⟨Host.provide Live.layer⟩

/-- Run a host's block until its role has every grant it asks for. -/
def settleHost {F : Access K → Type} (body : {role : Access K} → Host role (F role))
    (graph : Graph K) :
    Nat → Access K → Construct K ((role : Access K) × F role × Hosting role)
  | 0, _ => throw "a host asks for a different grant every time it is built"
  | passes + 1, role => do
    set graph
    match ← ((body (role := role)).run {}).run with
    | .ok (a, hosting) => return ⟨role, a, hosting⟩
    | .error missing => settleHost body graph passes (role.join missing)

/--
Declare a host from its block. The block is run as the stack is built: its
bindings become the host's role, and its listeners are registered.
-/
def hostOf (k : K) (id : String) (props : Cloud.Props k)
    (body : {role : Access K} → Host role (Cloud.Request k → Run role Never (Cloud.Response k))) :
    Construct K (Ref k) := do
  let ⟨role, fetch, hosting⟩ ←
    settleHost (F := fun role => Cloud.Request k → Run role Never (Cloud.Response k)) body (← get) 64 ∅
  declare {
    kind := k, ref := ⟨id⟩, props
    serve := some {
      access := role
      fetch := fun request => (fetch request).mapError fun e => nomatch e
      on := hosting.on }
    sites := hosting.sites }
  return ⟨id⟩

end Alchemy.Cloud

namespace Alchemy.Cloud

variable {K : Type} [Cloud K]

/-- Whether this grant is asked for by a call in the node's code. -/
def Node.calledFor (node : Node K) (grant : Attempt K) : Bool :=
  node.sites.any fun site => site.1.holds grant

/--
Every grant of every host is asked for by a call written in that host's code.
It is read off the code when the file is checked: no run is needed. A grant no
call asks for cannot be in a role at all.
-/
def Graph.NoUnusedPermissions (g : Graph K) : Prop :=
  (g.nodes.all fun node => node.access.atoms.all node.calledFor) = true

instance (g : Graph K) : Decidable g.NoUnusedPermissions :=
  inferInstanceAs (Decidable (_ = true))

/-- The calls that ask for a grant. -/
def Graph.why (g : Graph K) (host : String) (grant : Attempt K) : List String :=
  match g.find host with
  | some node => (node.sites.filter (·.1.holds grant)).map (·.2)
  | none => []

end Alchemy.Cloud
