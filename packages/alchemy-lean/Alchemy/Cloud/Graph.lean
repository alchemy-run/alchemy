import Alchemy.Cloud.Layer

/-!
# The resource graph

A `Construct` declares resources and the hosts that use them. Building a stack
runs its constructs and gives a `Graph`: a plain value that a deploy walks, a
runtime serves from, and a proof computes with.
-/

namespace Alchemy.Cloud

variable {K : Type} [Cloud K]

/-- An error a host left unhandled, as it is reported. -/
abbrev Failure := String

/-- A host listening to a resource. -/
structure Subscription (access : Access K) where
  kind : K
  source : Ref kind
  /-- What listening exercises of the host's access. -/
  needs : List (Attempt K) := []
  handle : Cloud.Event kind → Run access Failure Unit

/-- What a host runs: its access, how it answers a request, and what it listens to. -/
structure Serve (k : K) where
  access : Access K
  fetch : Cloud.Request k → Run access Failure (Cloud.Response k)
  on : List (Subscription access) := []

/-- A resource in the graph. A host is a resource that also runs code. -/
structure Node (K : Type) [Cloud K] where
  kind : K
  ref : Ref kind
  props : Cloud.Props kind
  serve : Option (Serve kind) := none

namespace Node

def id (n : Node K) : String := n.ref.id

/-- The access a node runs with. A resource that runs no code has none. -/
def access (n : Node K) : Access K :=
  match n.serve with
  | some serve => serve.access
  | none => ∅

/-- The ids of the resources a node needs to exist before it does. -/
def needs (n : Node K) : List String :=
  let listened := match n.serve with
    | some serve => serve.on.map (·.source.id)
    | none => []
  (Cloud.refs n.props ++ n.access.atoms.map (·.ref.id) ++ listened).eraseDups

end Node

/-- The resources of a stack. -/
structure Graph (K : Type) [Cloud K] where
  nodes : List (Node K) := []

namespace Graph

def ids (g : Graph K) : List String := g.nodes.map (·.id)

def find (g : Graph K) (id : String) : Option (Node K) := g.nodes.find? (·.id == id)

/-- The access a host runs with. -/
def roleOf (g : Graph K) (id : String) : Access K :=
  match g.find id with
  | some node => node.access
  | none => ∅

/-- Every node with the access it runs with. -/
def roles (g : Graph K) : List (String × Access K) := g.nodes.map fun n => (n.id, n.access)

/-- The hosts that may do this. -/
def whoCan (g : Graph K) (t : Attempt K) : List String :=
  (g.roles.filter (·.2.permits t)).map (·.1)

theorem mem_whoCan (g : Graph K) (t : Attempt K) (host : String) :
    host ∈ g.whoCan t ↔ (g.roles.any fun role => role.1 == host && role.2.permits t) = true := by
  simp [whoCan]
  constructor
  · rintro ⟨access, mem, permits⟩; exact ⟨host, access, mem, rfl, permits⟩
  · rintro ⟨_, access, mem, rfl, permits⟩; exact ⟨access, mem, permits⟩

/-- Whether this host may do this. -/
def can (g : Graph K) (host : String) (t : Attempt K) : Bool :=
  g.roles.any fun role => role.1 == host && role.2.permits t

/-- Each node with what it needs: the edges of the graph. -/
def edges (g : Graph K) : List (String × String) :=
  g.nodes.flatMap fun n => n.needs.map fun to => (n.id, to)

/-- Grants and references that name a resource the stack never declared. -/
def dangling (g : Graph K) : List (String × String) := g.edges.filter fun e => !g.ids.contains e.2

def orderLoop (g : Graph K) : Nat → List String → List String
  | 0, done => done
  | fuel + 1, done =>
    let ready := (g.nodes.filter fun n =>
      !done.contains n.id && n.needs.all fun need => need == n.id || done.contains need).map (·.id)
    if ready.isEmpty then done else g.orderLoop fuel (done ++ ready)

/-- An order to create the resources in: each after everything it needs. -/
def order (g : Graph K) : List String := g.orderLoop g.nodes.length []

/-- Every resource can be created: nothing dangles and nothing waits on itself in a circle. -/
def deployable (g : Graph K) : Bool := g.dangling.isEmpty && g.order.length == g.nodes.length

end Graph

/--
Settles a claim about who may do what, given the stack's roles: `access [roles]`.
Other facts it should use, such as how a kind's grants cover one another, go in
the list too.
-/
syntax "access" " [" Lean.Parser.Tactic.simpLemma,* "]" : tactic

macro_rules
  | `(tactic| access [$lemmas,*]) =>
    `(tactic| simp [Graph.mem_whoCan, Graph.can, Access.permits,
        permitsOn, Kinds.covers, $lemmas,*] at *)

/-- What a construct can read about where it is being built. -/
structure Env where
  stage : String

/-- Declares resources. The same construct is run to deploy a stack and to serve it. -/
abbrev Construct (K : Type) [Cloud K] := ReaderT Env (StateT (Graph K) (Except String))

/-- The stage being built: "prod", "dev", ... -/
def stage : Construct K String := return (← read).stage

def declare (node : Node K) : Construct K Unit := do
  let graph ← get
  if graph.ids.contains node.id then
    throw s!"two resources are named \"{node.id}\""
  set { graph with nodes := graph.nodes ++ [node] }

/-- Declare a resource. -/
def resource (k : K) (id : String) (props : Cloud.Props k) : Construct K (Ref k) := do
  declare { kind := k, ref := ⟨id⟩, props }
  return ⟨id⟩

/-- Declare a host. Its body declares what it uses and returns what it runs. -/
def host (k : K) (id : String) (props : Cloud.Props k) (body : Construct K (Serve k)) :
    Construct K (Ref k) := do
  let serve ← body
  declare { kind := k, ref := ⟨id⟩, props, serve := some serve }
  return ⟨id⟩

/-- Code that listens to a resource, written against the services it needs. -/
structure Listener (R : Service K) where
  kind : K
  source : Ref kind
  /-- What listening exercises of the host's access. -/
  needs : List (Attempt K) := []
  /-- How it can fail. -/
  Error : Type
  describe : Error → String
  handle : Cloud.Event kind → Effect R Error Unit

/--
What a host runs, and the layer that gives it its services. Written last in a
host's body. The host's access is what the layer needs, and nothing else. What
answers a request has handled every error; a listener may leave one, and it is
reported as it prints.
-/
def serve {k : K} {R : Service K} (layer : Layer Nothing R)
    (fetch : Cloud.Request k → Effect R Never (Cloud.Response k))
    (on : List (Listener R) := []) : Construct K (Serve k) :=
  return {
    access := layer.needs
    fetch := fun request => ((fetch request).provide layer).mapError fun e => nomatch e
    on := on.map fun listener =>
      { kind := listener.kind, source := listener.source, needs := listener.needs
        handle := fun event => ((listener.handle event).provide layer).mapError listener.describe } }

/-- A stack: a named construct, and what it reports once deployed. -/
structure Stack (K : Type) [Cloud K] (Out : Type) where
  name : String
  body : Construct K Out

namespace Stack

variable {Out : Type}

def build (s : Stack K Out) (stage : String) : Except String (Out × Graph K) :=
  (s.body.run { stage }).run {}

/-- The graph of a stack at a stage. Empty if the stack does not build. -/
def graph (s : Stack K Out) (stage : String) : Graph K :=
  match s.build stage with
  | .ok (_, graph) => graph
  | .error _ => {}

/-- What the stack reports at a stage: its handles, for stories and theorems to name. -/
def outputs [Inhabited Out] (s : Stack K Out) (stage : String) : Out :=
  match s.build stage with
  | .ok (out, _) => out
  | .error _ => default

/-- Why the stack does not build, if it does not. -/
def problem (s : Stack K Out) (stage : String) : Option String :=
  match s.build stage with
  | .ok _ => none
  | .error e => some e

end Stack

end Alchemy.Cloud
