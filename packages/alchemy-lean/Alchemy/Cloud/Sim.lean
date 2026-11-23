import Alchemy.Cloud.Graph

/-!
# Running a graph in memory

A `Sim` says what each call does to a cloud held in memory. With one, a graph
runs with no account and no emulator: requests go to hosts, calls change the
state, and events reach the hosts that listen.
-/

namespace Alchemy.Cloud

variable {K : Type} [Cloud K]

/-- Something a resource told its subscribers. -/
structure Emitted (K : Type) [Cloud K] where
  kind : K
  source : Ref kind
  event : Cloud.Event kind

/-- A cloud in memory. -/
structure Sim (K : Type) [Cloud K] where
  State : Type
  init : State
  /-- What a call answers, what it leaves behind, and what it tells subscribers. -/
  call : {k : K} → Ref k → (c : Cloud.Call k) → State → Cloud.Reply c × State × List (Emitted K)

/-- What running some code did. -/
structure Outcome (K : Type) [Cloud K] (sim : Sim K) (ε α : Type) where
  result : Except ε α
  state : sim.State
  events : List (Emitted K)
  /-- Every call made, as the attempt it was. -/
  attempts : List (Attempt K)

namespace Run

variable {access : Access K} {ε α : Type}

/-- Run against a cloud in memory. -/
def exec (sim : Sim K) : Run access ε α → sim.State → Outcome K sim ε α
  | .pure a, s => ⟨.ok a, s, [], []⟩
  | .fail e, s => ⟨.error e, s, [], []⟩
  | .call ref c _ next, s =>
    let step := sim.call ref c s
    let rest := (next step.1).exec sim step.2.1
    { rest with
      events := step.2.2 ++ rest.events
      attempts := ⟨_, ref, Cloud.needs c⟩ :: rest.attempts }

/--
Code only does what its access permits: every call it makes, against any cloud
in any state, is one its access allows.
-/
theorem exec_permitted (sim : Sim K) (run : Run access ε α) (s : sim.State) :
    ∀ t ∈ (run.exec sim s).attempts, access.permits t = true := by
  induction run generalizing s with
  | pure a => simp [exec]
  | fail e => simp [exec]
  | call ref c ok next ih =>
    intro t mem
    simp only [exec, List.mem_cons] at mem
    rcases mem with rfl | mem
    · exact ok
    · exact ih _ _ t mem

end Run

/-- A stack running in memory. -/
structure Running (K : Type) [Cloud K] (sim : Sim K) where
  state : sim.State
  /-- Events not yet delivered. -/
  pending : List (Emitted K) := []
  /-- Every call made so far, with the host that made it. -/
  used : List (String × Attempt K) := []
  /-- Listeners that gave up, and why. -/
  failures : List String := []

namespace Graph

variable {sim : Sim K}

def start (_ : Graph K) (sim : Sim K) : Running K sim := { state := sim.init }

/-- What a host would run for this request, if it is a host of this kind. -/
def handler (g : Graph K) {k : K} (host : Ref k) (request : Cloud.Request k) :
    Option ((access : Access K) × Run access Failure (Cloud.Response k)) :=
  match g.find host.id with
  | none => none
  | some node =>
    if h : node.kind = k then
      match node.serve with
      | none => none
      | some serve => some ⟨serve.access, h ▸ serve.fetch (h ▸ request)⟩
    else none

/-- Send a host a request. -/
def invoke (g : Graph K) {k : K} (host : Ref k) (request : Cloud.Request k) (w : Running K sim) :
    Option (Except Failure (Cloud.Response k)) × Running K sim :=
  match g.handler host request with
  | none => (none, w)
  | some ⟨_, run⟩ =>
    let out := run.exec sim w.state
    (some out.result,
      { w with
        state := out.state
        pending := w.pending ++ out.events
        used := w.used ++ out.attempts.map fun t => (host.id, t) })

/-- What a subscription would run for this event, if it listens to its source. -/
def Subscription.react {access : Access K} (sub : Subscription access) (e : Emitted K) :
    Option (Run access Failure Unit) :=
  if h : e.kind = sub.kind then
    if sub.source.id == e.source.id then some (sub.handle (h ▸ e.event)) else none
  else none

/-- Deliver an event to one host's listeners. -/
def deliverTo (node : Node K) (e : Emitted K) (w : Running K sim) : Running K sim :=
  match node.serve with
  | none => w
  | some serve =>
    serve.on.foldl (init := w) fun w sub =>
      match Subscription.react sub e with
      | none => w
      | some run =>
        let out := run.exec sim w.state
        { state := out.state
          pending := w.pending ++ out.events
          used := w.used ++ (sub.needs ++ out.attempts).map fun t => (node.id, t)
          failures := match out.result with
            | .ok () => w.failures
            | .error why => w.failures ++ [s!"{node.id}: {why}"] }

/-- Deliver events until none are left, or the fuel runs out. -/
def settle (g : Graph K) : Nat → Running K sim → Running K sim
  | 0, w => w
  | fuel + 1, w =>
    match w.pending with
    | [] => w
    | e :: rest => g.settle fuel (g.nodes.foldl (fun w node => deliverTo node e w) { w with pending := rest })

/-- A step of a story about a stack. -/
inductive Step (K : Type) [Cloud K] (sim : Sim K) where
  /-- A request to a host, and what the answer must be. -/
  | request {k : K} (host : Ref k) (request : Cloud.Request k) (expect : Cloud.Response k → Bool)
  /-- Something that must be true of the cloud now. -/
  | holds (what : String) (check : sim.State → Bool)

/-- Play a story. `none` once a step fails. -/
def play (g : Graph K) (steps : List (Step K sim)) : Option (Running K sim) :=
  steps.foldl (init := some (g.start sim)) fun w step =>
    match w, step with
    | none, _ => none
    | some w, .request host request expect =>
      match g.invoke host request w with
      | (some (.ok response), w) =>
        let w := g.settle 1000 w
        if expect response && w.failures.isEmpty then some w else none
      | _ => none
    | some w, .holds _ check => if check w.state then some w else none

/-- Whether a story plays out as written. -/
def passes (g : Graph K) (steps : List (Step K sim)) : Bool := (g.play steps).isSome

/-- The grants a world never exercised, with the host that holds each. -/
def unused (g : Graph K) (w : Running K sim) : List (String × Attempt K) :=
  g.nodes.flatMap fun node =>
    (node.access.atoms.filter fun grant =>
      !w.used.any fun (host, t) => host == node.id && permitsOn grant.ref grant.op t).map
        fun grant => (node.id, grant)

/--
Whether the stories together exercise every grant of every host. A grant no
story needs is one to remove, or a story to write.
-/
def exercised (g : Graph K) (stories : List (List (Step K sim))) : Bool :=
  let used := stories.flatMap fun story =>
    match g.play story with
    | some w => w.used
    | none => []
  (g.unused { state := sim.init, used }).isEmpty

end Graph

end Alchemy.Cloud
