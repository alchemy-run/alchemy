import Alchemy.Program
import Alchemy.View

/-!
A model, and everything a deployed one can do.

`Step` is one thing that can happen: a caller sends a command, a decision
records on several instances, an event reaches the policies in any order or a
second time, a policy or a saga takes its next step, an outside system answers
anything it may, time passes, a scheduled command fires. A rule proved for every
`Reachable` world holds whatever order those happen in.
-/
namespace Alchemy

variable {g : Aggregates} {σ : Signature}

/-- Replaces one value of a function. -/
def update {α β : Type} [DecidableEq α] (f : α → β) (a : α) (b : β) : α → β :=
  fun x => if x = a then b else f x

/-- The states with one instance's replaced. -/
def States.set (state : States g) (n : g.Name) (id : (g.of n).Id) (s : (g.of n).State) :
    States g :=
  fun n' id' =>
    if h : n = n' then
      if h ▸ id = id' then h ▸ s else state n' id'
    else state n' id'

/-- Every instance's state, and every event recorded, in order. -/
structure Recorded (g : Aggregates) where
  state : States g
  log : List (Emitted g)

namespace Recorded

/-- Before anything is recorded. -/
def start (g : Aggregates) : Recorded g where
  state := fun n _ => (g.of n).initial
  log := []

/-- Records events on one instance. -/
def record (r : Recorded g) (time : Time) (n : g.Name) (id : (g.of n).Id)
    (es : List (g.of n).Event) : Recorded g where
  state := r.state.set n id ((g.of n).apply (r.state n id) es time)
  log := r.log ++ es.zipIdx.map fun (e, i) => ⟨n, id, e, r.log.length + i, time⟩

/-- What a command answers, as things stand. -/
def outcome (r : Recorded g) (now : Time) (s : Send g) : Answer g s.to :=
  (g.of s.to).decide ⟨s.actor, now⟩ (r.state s.to ((g.of s.to).keyOf s.command)) s.command

/-- Sends one command to its instance: records its events, or changes nothing. -/
def dispatch (r : Recorded g) (now : Time) (s : Send g) : Recorded g :=
  match r.outcome now s with
  | .ok es => r.record now s.to ((g.of s.to).keyOf s.command) es
  | .error _ => r

/-- The instances of one aggregate that recorded anything. -/
def ids (r : Recorded g) (n : g.Name) : List (g.of n).Id :=
  (r.log.filterMap fun e => if h : e.source = n then some (h ▸ e.id) else none).eraseDups

/-- The events one aggregate's instances recorded, in order. -/
def eventsOf (r : Recorded g) (n : g.Name) : List (g.of n).Event :=
  r.log.filterMap fun e => if h : e.source = n then some (h ▸ e.event) else none

def records (r : Recorded g) (time : Time) (rs : List (Record g)) : Recorded g :=
  rs.foldl (fun r x => r.record time x.to x.id [x.event]) r

end Recorded

namespace Recorded

/-- The instance recorded on has the events applied. -/
@[simp] theorem record_state_self (r : Recorded g) (time : Time) (n : g.Name) (id : (g.of n).Id)
    (es : List (g.of n).Event) :
    (r.record time n id es).state n id = (g.of n).apply (r.state n id) es time := by
  simp [record, States.set]

/-- Another instance of the same aggregate is left alone. -/
theorem record_state_of_ne (r : Recorded g) (time : Time) (n : g.Name) (id id' : (g.of n).Id)
    (es : List (g.of n).Event) (h : id ≠ id') :
    (r.record time n id es).state n id' = r.state n id' := by
  simp [record, States.set, h]

/-- Another aggregate is left alone. -/
theorem record_state_of_ne_name (r : Recorded g) (time : Time) (n n' : g.Name) (id : (g.of n).Id)
    (id' : (g.of n').Id) (es : List (g.of n).Event) (h : n ≠ n') :
    (r.record time n id es).state n' id' = r.state n' id' := by
  simp [record, States.set, h]

/-- A command leaves every other aggregate alone. -/
theorem dispatch_state_of_ne_name (r : Recorded g) (now : Time) (s : Send g) (n : g.Name)
    (id : (g.of n).Id) (h : s.to ≠ n) : (r.dispatch now s).state n id = r.state n id := by
  unfold dispatch
  split
  · exact record_state_of_ne_name _ _ _ _ _ _ _ h
  · rfl

end Recorded

namespace Recorded

/-- Recording on an aggregate adds its events to that aggregate's, in order. -/
theorem eventsOf_record_self (r : Recorded g) (time : Time) (n : g.Name) (id : (g.of n).Id)
    (es : List (g.of n).Event) : (r.record time n id es).eventsOf n = r.eventsOf n ++ es := by
  simp only [eventsOf, record, List.filterMap_append]
  congr 1
  have pairs : ∀ pairs : List ((g.of n).Event × Nat),
      (pairs.map fun (e, i) => (⟨n, id, e, r.log.length + i, time⟩ : Emitted g)).filterMap
        (fun e => if h : e.source = n then some (h ▸ e.event) else none) = pairs.map Prod.fst := by
    intro pairs
    induction pairs with
    | nil => rfl
    | cons p ps ih => simp_all
  rw [pairs]
  simp

/-- What recording adds to the log: the old entries, then one for each event, on that instance. -/
theorem mem_record_log {r : Recorded g} {time : Time} {n : g.Name} {id : (g.of n).Id}
    {es : List (g.of n).Event} {e : Emitted g} (h : e ∈ (r.record time n id es).log) :
    e ∈ r.log ∨ ∃ x ∈ es, ∃ seq, e = ⟨n, id, x, seq, time⟩ := by
  simp only [record, List.mem_append, List.mem_map] at h
  rcases h with old | ⟨⟨x, i⟩, mem, rfl⟩
  · exact .inl old
  · exact .inr ⟨x, (List.mem_zipIdx mem).1 |> fun _ => by
      have := List.fst_mem_of_mem_zipIdx mem
      exact this, _, rfl⟩

/-- Recording keeps what was in the log. -/
theorem log_subset_record (r : Recorded g) (time : Time) (n : g.Name) (id : (g.of n).Id)
    (es : List (g.of n).Event) : ∃ more, (r.record time n id es).log = r.log ++ more :=
  ⟨_, rfl⟩

/-- Each event recorded is among the entries the recording added. -/
theorem mem_log_of_recorded (r : Recorded g) (time : Time) (n : g.Name) (id : (g.of n).Id)
    (es : List (g.of n).Event) {x : (g.of n).Event} (h : x ∈ es) :
    ∃ seq, (⟨n, id, x, seq, time⟩ : Emitted g) ∈ ((r.record time n id es).log).drop r.log.length := by
  simp only [record, List.drop_left]
  have general : ∀ (k : Nat) (es : List (g.of n).Event), x ∈ es →
      ∃ seq, (⟨n, id, x, seq, time⟩ : Emitted g) ∈
        (es.zipIdx k).map fun (e, i) => (⟨n, id, e, r.log.length + i, time⟩ : Emitted g) := by
    intro k es
    induction es generalizing k with
    | nil => intro h; cases h
    | cons y ys ih =>
      intro h
      rcases List.mem_cons.mp h with rfl | rest
      · exact ⟨r.log.length + k, by simp only [List.zipIdx_cons, List.map_cons]; exact List.mem_cons_self⟩
      · obtain ⟨seq, mem⟩ := ih (k + 1) rest
        exact ⟨seq, by simp only [List.zipIdx_cons, List.map_cons]; exact List.mem_cons_of_mem _ mem⟩
  exact general 0 es h

/-- A command either changes nothing, or records the events it was answered with. -/
theorem dispatch_cases (r : Recorded g) (now : Time) (s : Send g) :
    r.dispatch now s = r ∨
      ∃ es, r.outcome now s = .ok es ∧
        r.dispatch now s = r.record now s.to ((g.of s.to).keyOf s.command) es := by
  unfold dispatch
  cases h : r.outcome now s with
  | ok es => exact .inr ⟨es, rfl, rfl⟩
  | error _ => exact .inl rfl

/-- Recording on one aggregate leaves another's events alone. -/
theorem eventsOf_record_of_ne (r : Recorded g) (time : Time) (n n' : g.Name) (id : (g.of n).Id)
    (es : List (g.of n).Event) (h : n ≠ n') : (r.record time n id es).eventsOf n' = r.eventsOf n' := by
  simp [eventsOf, record, List.filterMap_append, h]

end Recorded

/--
A command decided across several instances at once: it reads any of them, and
records on all of them or on none.
-/
structure Decision (g : Aggregates) where
  name : String
  Command : Type
  Rejection : Type
  Actor : Type
  decide : Context Actor → States g → Command → Except Rejection (List (Record g))
  [decEqRejection : DecidableEq Rejection]

attribute [instance] Decision.decEqRejection

/-- What a decision leaves. -/
def Recorded.decide (r : Recorded g) (d : Decision g) (ctx : Context d.Actor)
    (c : d.Command) : Recorded g :=
  match d.decide ctx r.state c with
  | .ok rs => r.records ctx.now rs
  | .error _ => r

/-- "Whenever this is recorded, do that." It is given the events recorded before. -/
structure Policy (σ : Signature) where
  name : String
  react : List (Emitted σ.aggregates) → Emitted σ.aggregates → Program σ Unit

namespace Policy

/-- A policy on one aggregate's events. -/
def on (name : String) (n : σ.aggregates.Name)
    (react : (σ.aggregates.of n).Id → (σ.aggregates.of n).Event → Program σ Unit) : Policy σ where
  name := name
  react := fun _ e => if h : n = e.source then react (h ▸ e.id) (h ▸ e.event) else .pure ()

/-- A policy on the events a view emits. -/
def onView (name : String) (v : View σ.aggregates)
    (react : v.Key → v.Event → Program σ Unit) : Policy σ where
  name := name
  react := fun history e =>
    (v.emittedBy history e).foldr (fun (k, x) rest => react k x >>= fun _ => rest) (.pure ())

end Policy

structure Model where
  name : String
  signature : Signature
  decisions : List (Decision signature.aggregates) := []
  views : List (View signature.aggregates) := []
  policies : List (Policy signature) := []
  projections : List (Projection signature.aggregates) := []
  streams : List (Stream signature.aggregates) := []
  queries : List (Query signature.aggregates) := []
  /-- What a saga's run does. -/
  saga : signature.Saga → signature.SagaInput → Program signature Unit := fun _ _ => .pure ()
  /-- The commands callers may send: all of them, unless the model says otherwise. -/
  offered : Send signature.aggregates → Prop := fun _ => True

/-- Where a saga's run stands. -/
inductive SagaStatus (σ : Signature) where
  | notStarted
  | running
  | completed
  | failed (failure : σ.Failure)
deriving DecidableEq

/-- A program part-way through: a policy's reaction, or a saga's run. -/
structure Fiber (σ : Signature) where
  /-- The saga's run this is, if it is one. -/
  owner : Option σ.Saga
  program : Program σ Unit
  /-- The commands to send if it fails, newest first. -/
  undo : List (σ.Failure → Send σ.aggregates)

/-- Everything about a running model. -/
structure World (σ : Signature) extends Recorded σ.aggregates where
  /-- The events not yet delivered to the policies. -/
  inbox : List (Emitted σ.aggregates)
  fibers : List (Fiber σ)
  sagas : σ.Saga → SagaStatus σ
  /-- The signals each run has not yet taken. -/
  signals : σ.Saga → List σ.Signal
  /-- The commands to send later, each with when. -/
  schedule : List (Time × Send σ.aggregates)
  now : Time

namespace World

def start (σ : Signature) : World σ where
  toRecorded := .start σ.aggregates
  inbox := []
  fibers := []
  sagas := fun _ => .notStarted
  signals := fun _ => []
  schedule := []
  now := 0

/-- Takes on what was recorded: the new events go to the inbox. -/
def lift (w : World σ) (r : Recorded σ.aggregates) : World σ :=
  { w with toRecorded := r, inbox := w.inbox ++ r.log.drop w.log.length }

def dispatch (w : World σ) (s : Send σ.aggregates) : World σ :=
  w.lift (w.toRecorded.dispatch w.now s)

def decide (w : World σ) (d : Decision σ.aggregates) (actor : d.Actor) (c : d.Command) :
    World σ :=
  w.lift (w.toRecorded.decide d ⟨actor, w.now⟩ c)

/-- Ends a fiber: a saga's run takes the status. -/
def finish (w : World σ) (owner : Option σ.Saga) (status : SagaStatus σ) : World σ :=
  match owner with
  | none => w
  | some saga => { w with sagas := update w.sagas saga status }

/-- Nothing is left to react to, and nothing is part-way through. -/
def Settled (w : World σ) : Prop := w.inbox = [] ∧ w.fibers = []

end World

namespace Model

variable (m : Model)

/-- A fiber's next step: the world after it, and the fibers that replace it. -/
def advance (w : World m.signature) (f : Fiber m.signature) :
    Option (World m.signature × List (Fiber m.signature)) :=
  match f.program with
  | .pure () => some (w.finish f.owner .completed, [])
  | .fail failure =>
    match f.undo with
    | [] => some (w.finish f.owner (.failed failure), [])
    | u :: rest => some (w.dispatch (u failure), [{ f with undo := rest }])
  | .send s k => some (w.dispatch s, [{ f with program := k (w.toRecorded.outcome w.now s) }])
  | .call _ _ => none
  | .await k =>
    match f.owner with
    | none => none
    | some saga =>
      match w.signals saga with
      | [] => none
      | signal :: rest =>
        some ({ w with signals := update w.signals saga rest }, [{ f with program := k signal }])
  | .compensate u k => some (w, [{ f with program := k, undo := u :: f.undo }])
  | .start saga input k =>
    match w.sagas saga with
    | .notStarted =>
      some ({ w with sagas := update w.sagas saga .running },
        [{ f with program := k }, { owner := some saga, program := m.saga saga input, undo := [] }])
    | _ => some (w, [{ f with program := k }])
  | .signal saga signal k =>
    some ({ w with signals := update w.signals saga (w.signals saga ++ [signal]) },
      [{ f with program := k }])
  | .schedule after s k =>
    some ({ w with schedule := w.schedule ++ [(w.now + after, s)] }, [{ f with program := k }])

/-- The world with every policy's reaction to one event started. -/
def react (w : World m.signature) (e : Emitted m.signature.aggregates) : World m.signature :=
  { w with
    fibers := w.fibers ++ m.policies.map fun p =>
      { owner := none, program := p.react (w.log.take e.seq) e, undo := [] } }

/-- One thing a deployed model can do. -/
inductive Step : World m.signature → World m.signature → Prop where
  /-- A caller sends a command the model offers. -/
  | send (w) (s : Send m.signature.aggregates) : m.offered s → Step w (w.dispatch s)
  /-- A caller sends a command a decision answers. -/
  | decide (w) (d : Decision m.signature.aggregates) (actor : d.Actor) (c : d.Command) :
      d ∈ m.decisions → Step w (w.decide d actor c)
  /-- An undelivered event reaches the policies, whichever one it is. -/
  | deliver (w) (e) (before after : List (Emitted m.signature.aggregates)) :
      w.inbox = before ++ e :: after →
      Step w (m.react { w with inbox := before ++ after } e)
  /-- An event reaches the policies a second time. -/
  | redeliver (w) (e) : e ∈ w.log → Step w (m.react w e)
  /-- A policy or a saga takes its next step, whichever one it is. -/
  | advance (w) (f) (before after : List (Fiber m.signature)) (w') (fs) :
      w.fibers = before ++ f :: after →
      m.advance w f = some (w', fs) →
      Step w { w' with fibers := before ++ fs ++ after }
  /-- An outside system answers a call, with anything it may. -/
  | answer (w) (f) (before after : List (Fiber m.signature)) (c) (k) (reply : m.signature.Reply c) :
      w.fibers = before ++ f :: after →
      f.program = .call c k →
      Step w { w with fibers := before ++ { f with program := k reply } :: after }
  /-- Time passes. -/
  | tick (w) (time : Time) : w.now ≤ time → Step w { w with now := time }
  /-- A scheduled command that is due is sent, whichever one it is. -/
  | fire (w) (due : Time) (s) (before after : List (Time × Send m.signature.aggregates)) :
      w.schedule = before ++ (due, s) :: after →
      due ≤ w.now →
      Step w ({ w with schedule := before ++ after }.dispatch s)

/-- The worlds a model can get to. -/
inductive Reachable : World m.signature → Prop where
  | start : Reachable (World.start m.signature)
  | step {w w'} : Reachable w → Step m w w' → Reachable w'

/-- What a rule about the record has to survive: a command, and each decision. -/
structure Kept (rule : Recorded m.signature.aggregates → Prop) : Prop where
  dispatch : ∀ r now s, rule r → rule (r.dispatch now s)
  decide : ∀ d ∈ m.decisions, ∀ r (ctx : Context d.Actor) c, rule r → rule (r.decide d ctx c)

theorem advance_recorded {w w' : World m.signature} {f fs}
    (h : m.advance w f = some (w', fs)) :
    w'.toRecorded = w.toRecorded ∨ ∃ s, w'.toRecorded = w.toRecorded.dispatch w.now s := by
  unfold advance at h
  split at h
  · cases h; left; unfold World.finish; split <;> rfl
  · split at h
    · cases h; left; unfold World.finish; split <;> rfl
    · cases h; right; exact ⟨_, rfl⟩
  · cases h; right; exact ⟨_, rfl⟩
  · cases h
  · split at h
    · cases h
    · split at h
      · cases h
      · cases h; left; rfl
  · cases h; left; rfl
  · split at h <;> cases h <;> left <;> rfl
  · cases h; left; rfl
  · cases h; left; rfl

/--
A rule about the record that survives every command and every decision holds in
every world the model can reach: nothing else changes what is recorded.
-/
theorem invariant {rule : Recorded m.signature.aggregates → Prop}
    (initially : rule (.start m.signature.aggregates)) (kept : m.Kept rule) :
    ∀ w, m.Reachable w → rule w.toRecorded := by
  intro w reach
  induction reach with
  | start => exact initially
  | step _ step ih =>
    cases step with
    | send s _ => exact kept.dispatch _ _ s ih
    | decide d actor c mem => exact kept.decide d mem _ _ c ih
    | deliver e before after _ => exact ih
    | redeliver e _ => exact ih
    | advance f before after w' fs _ adv =>
      rcases m.advance_recorded adv with same | ⟨s, sent⟩
      · show rule w'.toRecorded
        rw [same]; exact ih
      · show rule w'.toRecorded
        rw [sent]; exact kept.dispatch _ _ s ih
    | answer f before after c k reply _ _ => exact ih
    | tick time _ => exact ih
    | fire due s before after _ _ => exact kept.dispatch _ _ s ih

/--
A rule about the whole world that every step keeps holds in every world the
model can reach.
-/
theorem worldInvariant {rule : World m.signature → Prop} (initially : rule (World.start m.signature))
    (kept : ∀ w w', rule w → m.Step w w' → rule w') : ∀ w, m.Reachable w → rule w := by
  intro w reach
  induction reach with
  | start => exact initially
  | step _ step ih => exact kept _ _ ih step

/-- A rule about each instance's state. -/
abbrev Rule (g : Aggregates) := (n : g.Name) → (g.of n).State → Prop

/-- Every instance satisfies the rule. -/
def Holds (P : Rule g) (r : Recorded g) : Prop :=
  ∀ n id, P n (r.state n id)

theorem record_holds {P : Rule g} (r : Recorded g) (time : Time) (n : g.Name)
    (id : (g.of n).Id) (es : List (g.of n).Event) (h : Holds P r)
    (after : P n ((g.of n).apply (r.state n id) es time)) : Holds P (r.record time n id es) := by
  intro n' id'
  simp only [Recorded.record, States.set]
  split
  · next same =>
    subst same
    split
    · next eq => subst eq; exact after
    · exact h _ _
  · exact h _ _

theorem dispatch_holds {P : Rule g} (kept : ∀ n, (g.of n).Keeps (P n))
    (r : Recorded g) (now : Time) (s : Send g) (h : Holds P r) : Holds P (r.dispatch now s) := by
  unfold Recorded.dispatch
  split
  · next es eq => exact record_holds r now _ _ es h (kept _ _ _ _ _ (h _ _) eq)
  · exact h

/-- Records keep a rule that each event recorded keeps. -/
theorem records_holds {P : Rule g} (time : Time) (rs : List (Record g))
    (evolves : ∀ x ∈ rs, (g.of x.to).Evolves (P x.to)) :
    ∀ r : Recorded g, Holds P r → Holds P (r.records time rs) := by
  unfold Recorded.records
  induction rs with
  | nil => intro r h; exact h
  | cons x rs ih =>
    intro r h
    refine ih (fun y mem => evolves y (List.mem_cons_of_mem _ mem)) _ ?_
    exact record_holds r time _ _ _ h
      ((evolves x List.mem_cons_self).apply _ _ _ (h _ _))

/--
A rule each aggregate keeps, and each decision keeps, holds for every instance
in every world the model can reach.
-/
theorem always {P : Rule m.signature.aggregates}
    (initially : ∀ n, P n (m.signature.aggregates.of n).initial)
    (kept : ∀ n, (m.signature.aggregates.of n).Keeps (P n))
    (decided : ∀ d ∈ m.decisions, ∀ r (ctx : Context d.Actor) c,
      Holds P r → Holds P (r.decide d ctx c)) :
    ∀ w, m.Reachable w → Holds P w.toRecorded :=
  m.invariant (fun n _ => initially n)
    { dispatch := fun r now s h => dispatch_holds kept r now s h
      decide := decided }

end Model
end Alchemy
