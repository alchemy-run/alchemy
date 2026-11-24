import Alchemy.Refines

/-!
# Views, kept as they are read

A view in the model is a function of the whole log. Stored, it is its state
and nothing else: each delivered event changes it once. For a view that looks
at an event as it is, the two are the same, so what a store answers for a view
is what the model says the view is.
-/
namespace Alchemy

variable {g : Aggregates}

/-- A view that looks at an event as it is: not where it sits in the log, nor what came before. -/
def View.Local (v : View g) : Prop := ∀ history e, v.on history e = v.on [] e.unplaced

/-- A table whose rows for an event depend on that event alone. -/
def Projection.Local (p : Projection g) : Prop :=
  ∀ history e, p.write history e = p.write [] e.unplaced

/-- A view as it is stored: its state at each key. -/
def View.reads (v : View g) : ReadSide g where
  State := v.Key → v.State
  initial := fun _ => v.initial
  apply := fun states e key => v.applyAt [] e key (states key)

/-- A table as it is stored: its rows. -/
def Projection.reads (p : Projection g) : ReadSide g where
  State := List p.Row
  initial := []
  apply := fun rows e => rows ++ p.write [] e

/-- The stored view, after every event, is the view the model computes from the log. -/
theorem View.reads_exact (v : View g) (plain : v.Local) (log : List (Emitted g)) (key : v.Key) :
    ((log.map Emitted.unplaced).foldl v.reads.apply v.reads.initial) key = v.stateAt log key := by
  suffices ∀ (rest history : List (Emitted g)) (states : v.reads.State),
      ((rest.map Emitted.unplaced).foldl v.reads.apply states) key
        = v.go key history rest (states key) from this log [] _
  intro rest
  induction rest with
  | nil => intro history states; rfl
  | cons e rest ih =>
    intro history states
    show (List.foldl v.reads.apply (v.reads.apply states e.unplaced) (rest.map Emitted.unplaced)) key
      = v.go key (history ++ [e]) rest (v.applyAt history e key (states key))
    rw [ih (history ++ [e]) (v.reads.apply states e.unplaced)]
    show v.go key _ rest (v.applyAt [] e.unplaced key (states key)) = _
    simp only [View.applyAt, plain history e]

/-- The stored table, after every event, is the table the model computes from the log. -/
theorem Projection.reads_exact (p : Projection g) (plain : p.Local) (log : List (Emitted g)) :
    (log.map Emitted.unplaced).foldl p.reads.apply p.reads.initial = p.table log := by
  suffices ∀ (rest history : List (Emitted g)) (rows : p.reads.State),
      (rest.map Emitted.unplaced).foldl p.reads.apply rows
        = List.append (α := p.Row) rows (p.go history rest) from
    (this log [] p.reads.initial).trans (List.nil_append _)
  intro rest
  induction rest with
  | nil => intro history rows; exact (List.append_nil (as := (rows : List p.Row))).symm
  | cons e rest ih =>
    intro history rows
    show List.foldl p.reads.apply (p.reads.apply rows e.unplaced) (rest.map Emitted.unplaced)
      = List.append (α := p.Row) rows (p.write history e ++ p.go (history ++ [e]) rest)
    rw [ih (history ++ [e]) (p.reads.apply rows e.unplaced)]
    show List.append (α := p.Row) (List.append (α := p.Row) rows (p.write [] e.unplaced)) _ = _
    rw [plain history e]
    exact List.append_assoc _ _ _

namespace ReadSide

/-- Two things read from one model, each kept up on its own. -/
def both (a b : ReadSide g) : ReadSide g where
  State := a.State × b.State
  initial := (a.initial, b.initial)
  apply := fun s e => (a.apply s.1 e, b.apply s.2 e)

theorem both_fold (a b : ReadSide g) (events : List (Emitted g)) :
    events.foldl (both a b).apply (both a b).initial
      = (events.foldl a.apply a.initial, events.foldl b.apply b.initial) := by
  suffices ∀ s : a.State × b.State,
      events.foldl (both a b).apply s = (events.foldl a.apply s.1, events.foldl b.apply s.2) from
    this _
  induction events with
  | nil => intro s; rfl
  | cons e rest ih => intro s; exact ih _

end ReadSide

/-- What a store answers for something read, once nothing is waiting to be delivered. -/
theorem Agrees.read_settled {σ : Signature} {reads : ReadSide σ.aggregates} {h : Held σ reads}
    {P : Process σ} {w : World σ} (agrees : Agrees h P w) (settled : h.pending = []) :
    h.read = (w.log.map Emitted.unplaced).foldl reads.apply reads.initial := by
  have empty : w.inbox = [] := by
    have := agrees.pending
    rw [settled] at this
    exact List.map_eq_nil_iff.mp this.symm
  rw [agrees.read, World.delivered, empty, List.length_nil, Nat.sub_zero, List.take_length]

end Alchemy
