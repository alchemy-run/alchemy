import Alchemy.Signature

/-!
What is read from a model. Each is a function of the log of recorded events,
so a read can never disagree with what was recorded.
-/
namespace Alchemy

variable {g : Aggregates}

/-- How one event changes a view at one key, and what the view emits for it. -/
structure View.Update (Key State Event : Type) where
  key : Key
  evolve : State → State
  /-- The view's own events, from the state before and after. -/
  emit : State → State → List Event := fun _ _ => []

/-- A read model, keyed by what it is about. -/
structure View (g : Aggregates) where
  name : String
  Key : Type
  State : Type
  /-- The events the view itself emits. -/
  Event : Type
  /-- Who reads it. -/
  Actor : Type
  Rejection : Type
  initial : State
  /-- What an event does to the view, given the events before it. -/
  on : List (Emitted g) → Emitted g → List (View.Update Key State Event)
  /-- Whether this actor may read this key. -/
  validate : Actor → Key → State → Except Rejection Unit := fun _ _ _ => .ok ()
  [decEqKey : DecidableEq Key]
  [decEqState : DecidableEq State]
  [decEqEvent : DecidableEq Event]
  [decEqRejection : DecidableEq Rejection]

namespace View

attribute [instance] View.decEqKey View.decEqState View.decEqEvent View.decEqRejection

variable (v : View g)

/-- One event applied to the state at a key. -/
def applyAt (history : List (Emitted g)) (e : Emitted g) (key : v.Key) (s : v.State) : v.State :=
  (v.on history e).foldl (fun s u => if u.key = key then u.evolve s else s) s

def go (key : v.Key) : List (Emitted g) → List (Emitted g) → v.State → v.State
  | _, [], s => s
  | history, e :: rest, s => go key (history ++ [e]) rest (v.applyAt history e key s)

/-- The view at a key, after everything in the log. -/
def stateAt (log : List (Emitted g)) (key : v.Key) : v.State :=
  v.go key [] log v.initial

/-- The view's own events for one event, given the events before it. -/
def emittedBy (history : List (Emitted g)) (e : Emitted g) : List (v.Key × v.Event) :=
  (v.on history e).flatMap fun u =>
    let before := v.stateAt history u.key
    (u.emit before (u.evolve before)).map fun x => (u.key, x)

def emittedGo : List (Emitted g) → List (Emitted g) → List (v.Key × v.Event)
  | _, [] => []
  | history, e :: rest => v.emittedBy history e ++ emittedGo (history ++ [e]) rest

/-- Every event the view emitted at a key, in order. -/
def emittedAt (log : List (Emitted g)) (key : v.Key) : List v.Event :=
  (v.emittedGo [] log).filterMap fun (k, x) => if k = key then some x else none

/-- The view at a key, for an actor who may read it. -/
def read (actor : v.Actor) (log : List (Emitted g)) (key : v.Key) : Except v.Rejection v.State :=
  let s := v.stateAt log key
  (v.validate actor key s).map fun _ => s

end View

/-- Rows written to a store outside the model, one batch per event. -/
structure Projection (g : Aggregates) where
  name : String
  Row : Type
  write : List (Emitted g) → Emitted g → List Row

namespace Projection

def go (p : Projection g) : List (Emitted g) → List (Emitted g) → List p.Row
  | _, [] => []
  | history, e :: rest => p.write history e ++ go p (history ++ [e]) rest

/-- Everything the projection was given. -/
def table (p : Projection g) (log : List (Emitted g)) : List p.Row :=
  p.go [] log

end Projection

/-- An ordered log per key that clients read. -/
structure Stream (g : Aggregates) where
  name : String
  Key : Type
  Entry : Type
  Actor : Type
  Rejection : Type
  append : List (Emitted g) → Emitted g → List (Key × Entry)
  /-- Whether this actor may read this key, given its latest entry. -/
  validate : Actor → Key → Option Entry → Except Rejection Unit := fun _ _ _ => .ok ()
  [decEqKey : DecidableEq Key]
  [decEqEntry : DecidableEq Entry]

namespace Stream

attribute [instance] Stream.decEqKey Stream.decEqEntry

def go (s : Stream g) : List (Emitted g) → List (Emitted g) → List (s.Key × s.Entry)
  | _, [] => []
  | history, e :: rest => s.append history e ++ go s (history ++ [e]) rest

def entries (s : Stream g) (log : List (Emitted g)) (key : s.Key) : List s.Entry :=
  (s.go [] log).filterMap fun (k, x) => if k = key then some x else none

def read (s : Stream g) (actor : s.Actor) (log : List (Emitted g)) (key : s.Key) :
    Except s.Rejection (List s.Entry) :=
  let all := s.entries log key
  (s.validate actor key all.getLast?).map fun _ => all

end Stream

/-- One page of a query's rows, and where the next page starts. -/
structure Page (Row : Type) where
  entries : List Row
  cursor : Option Nat
deriving DecidableEq, Repr

/-- A question across keys, answered from the log by a handler that judges the caller. -/
structure Query (g : Aggregates) where
  name : String
  Input : Type
  Row : Type
  Actor : Type
  Rejection : Type
  handle : Actor → List (Emitted g) → Input → Except Rejection (List Row)

namespace Query

/-- A page of the rows: `take` of them, after the first `after`. -/
def ask (q : Query g) (actor : q.Actor) (log : List (Emitted g)) (input : q.Input)
    (after : Nat := 0) (take : Nat := 50) : Except q.Rejection (Page q.Row) :=
  (q.handle actor log input).map fun rows =>
    let rest := rows.drop after
    { entries := rest.take take
      cursor := if rest.length > take then some (after + take) else none }

end Query
end Alchemy

namespace Alchemy

variable {g : Aggregates}

/-- A view with one value, folded over every event. -/
abbrev View.fold {State : Type} [DecidableEq State] (name : String) (initial : State)
    (step : State → Emitted g → State) : View g where
  name := name
  Key := Unit
  State := State
  Event := Empty
  Actor := Unit
  Rejection := Empty
  initial := initial
  on := fun _ event => [{ key := (), evolve := fun state => step state event }]

theorem View.fold_go {State : Type} [DecidableEq State] (name : String) (initial : State)
    (step : State → Emitted g → State) (history log : List (Emitted g)) (state : State) :
    (View.fold name initial step).go () history log state = log.foldl step state := by
  induction log generalizing history state with
  | nil => rfl
  | cons event rest ih =>
    show (View.fold name initial step).go () (history ++ [event]) rest
      ((View.fold name initial step).applyAt history event () state) = _
    rw [ih]
    simp [View.applyAt]

/-- A folded view is exactly the fold of its step over the log, whatever was recorded. -/
theorem View.fold_exact {State : Type} [DecidableEq State] (name : String) (initial : State)
    (step : State → Emitted g → State) (log : List (Emitted g)) :
    (View.fold name initial step).stateAt log () = log.foldl step initial :=
  View.fold_go name initial step [] log initial

/-- A projection that writes rows for each event by itself. -/
abbrev Projection.each {Row : Type} (name : String) (rows : Emitted g → List Row) : Projection g where
  name := name
  Row := Row
  write := fun _ event => rows event

theorem Projection.each_go {Row : Type} (name : String) (rows : Emitted g → List Row)
    (history log : List (Emitted g)) :
    (Projection.each name rows).go history log = log.flatMap rows := by
  induction log generalizing history with
  | nil => rfl
  | cons event rest ih =>
    show rows event ++ (Projection.each name rows).go (history ++ [event]) rest = _
    rw [ih]
    rfl

/-- Such a projection is given exactly each event's rows, in order: none missed, none twice. -/
theorem Projection.each_exact {Row : Type} (name : String) (rows : Emitted g → List Row)
    (log : List (Emitted g)) : (Projection.each name rows).table log = log.flatMap rows :=
  Projection.each_go name rows [] log

end Alchemy
