import Alchemy.Model

/-!
# What an instance's history says about it

Rules about one state are lifted by `Model.always`. These lift rules that tie a
state to the events its instance recorded: a quantity that is the sum of what
was recorded, an event that is only ever recorded after another. Each is proved
of the aggregate alone, one command at a time, and holds of every instance in
every world a model can reach.
-/
namespace Alchemy

variable {g : Aggregates}

namespace Recorded

/-- The events one instance recorded, in order. -/
def eventsAt (r : Recorded g) (n : g.Name) (id : (g.of n).Id) : List (g.of n).Event :=
  r.log.filterMap fun e =>
    if h : e.source = n then (if h ▸ e.id = id then some (h ▸ e.event) else none) else none

/-- Recording on an instance adds the events to its own, in order. -/
theorem eventsAt_record_self (r : Recorded g) (time : Time) (n : g.Name) (id : (g.of n).Id)
    (es : List (g.of n).Event) :
    (r.record time n id es).eventsAt n id = r.eventsAt n id ++ es := by
  simp only [eventsAt, record, List.filterMap_append]
  congr 1
  have pairs : ∀ pairs : List ((g.of n).Event × Nat),
      (pairs.map fun (e, i) => (⟨n, id, e, r.log.length + i, time⟩ : Emitted g)).filterMap
        (fun e => if h : e.source = n then (if h ▸ e.id = id then some (h ▸ e.event) else none)
          else none) = pairs.map Prod.fst := by
    intro pairs
    induction pairs with
    | nil => rfl
    | cons p ps ih => simp_all
  rw [pairs]
  simp

/-- Recording on another instance of the same aggregate leaves an instance's events alone. -/
theorem eventsAt_record_of_ne (r : Recorded g) (time : Time) (n : g.Name) (id id' : (g.of n).Id)
    (es : List (g.of n).Event) (h : id ≠ id') :
    (r.record time n id es).eventsAt n id' = r.eventsAt n id' := by
  simp only [eventsAt, record, List.filterMap_append]
  suffices ∀ pairs : List ((g.of n).Event × Nat),
      (pairs.map fun (e, i) => (⟨n, id, e, r.log.length + i, time⟩ : Emitted g)).filterMap
        (fun e => if h : e.source = n then (if h ▸ e.id = id' then some (h ▸ e.event) else none)
          else none) = [] by
    rw [this]; simp
  intro pairs
  induction pairs with
  | nil => rfl
  | cons p ps ih => simp_all

/-- Recording on another aggregate leaves an instance's events alone. -/
theorem eventsAt_record_of_ne_name (r : Recorded g) (time : Time) (n n' : g.Name)
    (id : (g.of n).Id) (id' : (g.of n').Id) (es : List (g.of n).Event) (h : n ≠ n') :
    (r.record time n id es).eventsAt n' id' = r.eventsAt n' id' := by
  simp [eventsAt, record, List.filterMap_append, h]

end Recorded

namespace Aggregate

variable (a : Aggregate)

/--
A rule that ties an instance's state to the events it recorded, and that every
accepted command keeps.
-/
structure Explains (R : a.State → List a.Event → Prop) : Prop where
  initially : R a.initial []
  kept : ∀ ctx s c es past, R s past → a.decide ctx s c = .ok es →
    R (a.apply s es ctx.now) (past ++ es)

/--
A quantity of the state that every accepted command moves by exactly what its
events are worth: a balance, a total charged, a count.
-/
def Tallies (quantity : a.State → Int) (worth : a.Event → Int) : Prop :=
  ∀ ctx s c es, a.decide ctx s c = .ok es →
    quantity (a.apply s es ctx.now) = quantity s + (es.map worth).sum

/-- So the quantity is always what it started as, plus the worth of everything recorded. -/
theorem Tallies.explains {a : Aggregate} {quantity : a.State → Int} {worth : a.Event → Int}
    (tallies : a.Tallies quantity worth) :
    a.Explains fun s past => quantity s = quantity a.initial + (past.map worth).sum where
  initially := by simp
  kept := by
    intro ctx s c es past h decided
    rw [tallies ctx s c es decided, h, List.map_append, List.sum_append]
    omega

/-- In these events, `effect` only comes after `cause`. -/
def Follows {Event : Type} (cause effect : Event → Prop) (past : List Event) : Prop :=
  ∀ before e after, past = before ++ e :: after → effect e → ∃ c ∈ before, cause c

/--
`effect` is only recorded once `cause` has been. `seen` is how the state shows
that `cause` was recorded: a command records `effect` only on a state that shows
it, and only a `cause` makes a state show it.
-/
structure Precedes (cause effect : a.Event → Prop) (seen : a.State → Prop) : Prop where
  /-- Nothing was recorded on a new instance. -/
  fresh : ¬seen a.initial
  /-- `effect` is recorded only where `cause` shows. -/
  guarded : ∀ ctx s c es, a.decide ctx s c = .ok es → ∀ e ∈ es, effect e → seen s
  /-- Only a `cause` makes the state show it. -/
  marks : ∀ ctx s c es, a.decide ctx s c = .ok es → seen (a.apply s es ctx.now) →
    seen s ∨ ∃ c ∈ es, cause c

theorem Precedes.explains {a : Aggregate} {cause effect : a.Event → Prop} {seen : a.State → Prop}
    (precedes : a.Precedes cause effect seen) :
    a.Explains fun s past => (seen s → ∃ c ∈ past, cause c) ∧ Follows cause effect past where
  initially := ⟨fun shown => absurd shown precedes.fresh, by
    intro before e after split
    cases before <;> cases split⟩
  kept := by
    intro ctx s c es past ⟨shows, follows⟩ decided
    refine ⟨fun shown => ?_, ?_⟩
    · rcases precedes.marks ctx s c es decided shown with before | ⟨x, mem, is⟩
      · obtain ⟨x, mem, is⟩ := shows before
        exact ⟨x, List.mem_append_left _ mem, is⟩
      · exact ⟨x, List.mem_append_right _ mem, is⟩
    · intro before e after split isEffect
      rcases List.append_eq_append_iff.mp split with ⟨middle, rfl, inNew⟩ | ⟨middle, rfl, inPast⟩
      · obtain ⟨x, mem, is⟩ := shows (precedes.guarded ctx s c es decided e (by rw [inNew]; simp) isEffect)
        exact ⟨x, List.mem_append_left _ mem, is⟩
      · cases middle with
        | nil =>
          rw [List.nil_append] at inPast
          obtain ⟨x, mem, is⟩ :=
            shows (precedes.guarded ctx s c es decided e (by rw [← inPast]; simp) isEffect)
          exact ⟨x, by simpa using mem, is⟩
        | cons x rest =>
          cases inPast
          exact follows before e rest rfl isEffect

/-- Any two commands, whoever sends them and when, leave the same state in either order. -/
def Commutes : Prop :=
  ∀ (x y : a.Sent) s, a.step y.1 (a.step x.1 s x.2) y.2 = a.step x.1 (a.step y.1 s y.2) x.2

/-- So the order commands arrive in does not matter: any reordering leaves the same state. -/
theorem Commutes.replay_perm {a : Aggregate} (commutes : a.Commutes) {cs cs' : List a.Sent}
    (reordered : cs.Perm cs') : ∀ s, a.replay s cs = a.replay s cs' := by
  induction reordered with
  | nil => intro s; rfl
  | cons x _ ih => intro s; exact ih _
  | swap x y rest => intro s; simp only [replay, List.foldl_cons, commutes y x s]
  | trans _ _ first second => intro s; exact (first s).trans (second s)

/-- A command delivered twice in a row leaves what it leaves delivered once. -/
theorem Idempotent.replay_again {a : Aggregate} (idempotent : a.Idempotent) (x : a.Sent)
    (cs : List a.Sent) (s : a.State) : a.replay s (x :: x :: cs) = a.replay s (x :: cs) := by
  simp only [replay, List.foldl_cons, idempotent x.2 x.1 s]

end Aggregate

namespace Model

/--
A rule that ties state to history, proved of one aggregate, holds of every
instance of it in every world a model with no decisions can reach.
-/
theorem explained (m : Model) (noDecisions : m.decisions = []) (n : m.signature.aggregates.Name)
    {R : (m.signature.aggregates.of n).State → List (m.signature.aggregates.of n).Event → Prop}
    (explains : (m.signature.aggregates.of n).Explains R)
    (w : World m.signature) (reach : m.Reachable w) (id : (m.signature.aggregates.of n).Id) :
    R (w.state n id) (w.toRecorded.eventsAt n id) := by
  refine m.invariant (rule := fun r => ∀ id, R (r.state n id) (r.eventsAt n id))
    (fun _ => explains.initially) ⟨?_, ?_⟩ w reach id
  · intro r now s holds id
    obtain ⟨to, actor, command⟩ := s
    rcases r.dispatch_cases now ⟨to, actor, command⟩ with same | ⟨es, decided, recorded⟩
    · rw [same]; exact holds id
    · rw [recorded]
      by_cases here : to = n
      · subst here
        by_cases this : (m.signature.aggregates.of to).keyOf command = id
        · subst this
          rw [Recorded.record_state_self, Recorded.eventsAt_record_self]
          exact explains.kept ⟨actor, now⟩ _ command es _ (holds _) decided
        · rw [Recorded.record_state_of_ne _ _ _ _ _ _ this, Recorded.eventsAt_record_of_ne _ _ _ _ _ _ this]
          exact holds id
      · rw [Recorded.record_state_of_ne_name _ _ _ _ _ _ _ here,
          Recorded.eventsAt_record_of_ne_name _ _ _ _ _ _ _ here]
        exact holds id
  · rw [noDecisions]; intro d mem; cases mem

end Model
end Alchemy
