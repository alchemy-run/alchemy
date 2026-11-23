import Alchemy.Aggregate

/-!
What a model is made of, before anything is implemented: its aggregates, the
outside systems it calls, and its sagas.
-/
namespace Alchemy

/-- The aggregates of a model, by name. -/
structure Aggregates where
  Name : Type
  of : Name → Aggregate
  [decEqName : DecidableEq Name]

attribute [instance] Aggregates.decEqName

/-- A command for one of the aggregates, and who sends it. -/
structure Send (g : Aggregates) where
  to : g.Name
  actor : (g.of to).Actor
  command : (g.of to).Command

/-- An event to record on one instance. -/
structure Record (g : Aggregates) where
  to : g.Name
  id : (g.of to).Id
  event : (g.of to).Event

/-- An event one instance recorded: where it sits in the log, and when. -/
structure Emitted (g : Aggregates) where
  source : g.Name
  id : (g.of source).Id
  event : (g.of source).Event
  seq : Nat
  time : Time

/-- Every instance's state. -/
abbrev States (g : Aggregates) := (n : g.Name) → (g.of n).Id → (g.of n).State

/-- What a command sent to an aggregate answers. -/
abbrev Answer (g : Aggregates) (n : g.Name) :=
  Except (g.of n).Rejection (List (g.of n).Event)

structure Signature where
  aggregates : Aggregates
  /-- A call to a system outside the model, with its arguments. -/
  Call : Type
  /-- What a call may answer. -/
  Reply : Call → Type
  /-- A saga's run, by what it is about. -/
  Saga : Type
  /-- What a run is started with. -/
  SagaInput : Type
  /-- What a run can be told while it waits. -/
  Signal : Type
  /-- How a run or a reaction can fail. -/
  Failure : Type
  [decEqCall : DecidableEq Call]
  [decEqSaga : DecidableEq Saga]
  [decEqFailure : DecidableEq Failure]

attribute [instance] Signature.decEqCall Signature.decEqSaga Signature.decEqFailure

end Alchemy
