/-!
An aggregate: a thing whose rules hold in one transaction. `decide` answers a
command with the events it records or a rejection, and `evolve` applies one
event to the state.
-/
namespace Alchemy

/-- A moment, in whatever unit the model counts in. -/
abbrev Time := Nat

/-- What a decision is made with: who asks, and when. -/
structure Context (Actor : Type) where
  actor : Actor
  now : Time

structure Aggregate where
  name : String
  Id : Type
  State : Type
  Command : Type
  Event : Type
  Rejection : Type
  /-- Who a command is sent by. -/
  Actor : Type
  /-- The state of an instance nothing was recorded on. -/
  initial : State
  /-- The instance a command is sent to. -/
  keyOf : Command → Id
  decide : Context Actor → State → Command → Except Rejection (List Event)
  /-- Applies one event, recorded at the given time. -/
  evolve : State → Event → Time → State
  /-- What an accepted command answers its caller. -/
  Reply : Type := Unit
  /-- The reply, from the state the command left. -/
  reply : State → Command → Reply := by exact fun _ _ => ()
  [decEqId : DecidableEq Id]
  [decEqState : DecidableEq State]
  [decEqEvent : DecidableEq Event]
  [decEqRejection : DecidableEq Rejection]
  [decEqReply : DecidableEq Reply]

namespace Aggregate

attribute [instance] Aggregate.decEqId Aggregate.decEqState Aggregate.decEqEvent
  Aggregate.decEqRejection Aggregate.decEqReply

variable (a : Aggregate)

/-- The state after every event, in order, all recorded at one time. -/
def apply (s : a.State) (es : List a.Event) (time : Time) : a.State :=
  es.foldl (fun s e => a.evolve s e time) s

/-- The state of an instance these events were recorded on, in order: the "given" of a scenario. -/
def after (es : List a.Event) : a.State := a.apply a.initial es 0

/-- The state after one command: unchanged when the command is rejected. -/
def step (ctx : Context a.Actor) (s : a.State) (c : a.Command) : a.State :=
  match a.decide ctx s c with
  | .ok es => a.apply s es ctx.now
  | .error _ => s

/-- A command with who sends it and when. -/
abbrev Sent := Context a.Actor × a.Command

/-- The state after every command, in order. -/
def replay (s : a.State) (cs : List a.Sent) : a.State :=
  cs.foldl (fun s c => a.step c.1 s c.2) s

/-- A rule no accepted command breaks. -/
def Keeps (P : a.State → Prop) : Prop :=
  ∀ ctx s c es, P s → a.decide ctx s c = .ok es → P (a.apply s es ctx.now)

/-- A rule no recorded event breaks, whoever records it: a command or a decision. -/
def Evolves (P : a.State → Prop) : Prop :=
  ∀ s e time, P s → P (a.evolve s e time)

/-- A rule about what a command may do to the state. -/
def Transition (R : Context a.Actor → a.State → a.Command → a.State → Prop) : Prop :=
  ∀ ctx s c es, a.decide ctx s c = .ok es → R ctx s c (a.apply s es ctx.now)

theorem Evolves.apply {a : Aggregate} {P : a.State → Prop} (kept : a.Evolves P)
    (es : List a.Event) (time : Time) : ∀ s, P s → P (a.apply s es time) := by
  induction es with
  | nil => intro s h; exact h
  | cons e es ih => intro s h; exact ih _ (kept s e time h)

theorem Evolves.keeps {a : Aggregate} {P : a.State → Prop} (kept : a.Evolves P) : a.Keeps P :=
  fun ctx s _ es h _ => kept.apply es ctx.now s h

theorem Keeps.step {a : Aggregate} {P : a.State → Prop} (kept : a.Keeps P)
    (ctx : Context a.Actor) (s : a.State) (c : a.Command) (h : P s) : P (a.step ctx s c) := by
  unfold Aggregate.step
  split
  · next es eq => exact kept ctx s c es h eq
  · exact h

theorem Keeps.replay {a : Aggregate} {P : a.State → Prop} (kept : a.Keeps P)
    (cs : List a.Sent) : ∀ s, P s → P (a.replay s cs) := by
  induction cs with
  | nil => intro s h; exact h
  | cons c cs ih => intro s h; exact ih _ (kept.step c.1 s c.2 h)

/-- A rule every state of an aggregate satisfies, with its proof. -/
structure Invariant (a : Aggregate) where
  name : String
  holds : a.State → Prop
  /-- It holds before anything is recorded. -/
  initially : holds a.initial
  /-- No accepted command breaks it. -/
  kept : a.Keeps holds

/-- An invariant holds after any sequence of commands. -/
theorem Invariant.always {a : Aggregate} (rule : Invariant a) (cs : List a.Sent) :
    rule.holds (a.replay a.initial cs) :=
  rule.kept.replay cs a.initial rule.initially

end Aggregate
end Alchemy
