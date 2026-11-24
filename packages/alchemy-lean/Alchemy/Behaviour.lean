import Alchemy.Attr
import Alchemy.Engine
import Alchemy.Compose

/-!
# Behaviour, proved by running

A behaviour theorem says: after these moves, this is true. It is proved by
running the model with its ids and amounts left as variables, one step at a
time. The lemmas here are the steps.
-/

namespace Alchemy

namespace Model

variable (m : Model)

/-- One more step of settling: take a step if there is one. -/
theorem settle_succ (fuel : Nat) (w : World m.signature) :
    m.settle (fuel + 1) w = (m.stepOnce w).elim w (m.settle fuel) := by
  show (match m.stepOnce w with
    | none => w
    | some w' => m.settle fuel w') = _
  cases m.stepOnce w <;> rfl

theorem settle_zero (w : World m.signature) : m.settle 0 w = w := rfl

end Model

theorem Program.pure_eq {σ : Signature} {α : Type} (a : α) :
    (Pure.pure a : Program σ α) = Program.pure a := rfl

theorem Program.bind_eq {σ : Signature} {α β : Type} (x : Program σ α) (f : α → Program σ β) :
    (Bind.bind x f : Program σ β) = Program.bind x f := rfl

namespace Link

variable {a b : Model} (link : Link a b)

theorem settle_succ (calls : Nat) (w : link.Worlds) :
    link.settle (calls + 1) w = (link.answerNext w).elim w (link.settle calls) := by
  show (match link.answerNext w with
    | none => w
    | some w' => link.settle calls w') = _
  cases link.answerNext w <;> rfl

theorem settle_zero (w : link.Worlds) : link.settle 0 w = w := rfl

end Link

attribute [behaviour]
  Model.run Model.play Model.settle_succ Model.settle_zero Model.stepOnce Model.tryFibers
  Model.advance Model.react Model.waiting Model.answer Model.answerGo Model.pass
  World.dispatch World.decide World.lift World.start World.finish
  Recorded.dispatch Recorded.decide Recorded.records Recorded.outcome Recorded.record Recorded.start
  States.set update Aggregate.apply Aggregate.after
  Policy.on Program.request Program.tell Program.step Program.ask Program.undoWith
  Program.startSaga Program.signalSaga Program.awaitSignal Program.later Program.bind
  Program.pure_eq Program.bind_eq Option.elim
  Link.run Link.play Link.settle_succ Link.settle_zero Link.answerNext Link.fuel
  Model.AtRest World.Settled

/--
Proves a behaviour theorem by running the model, with its variables left as
they are. Each `if` on the way is decided by arithmetic from the hypotheses, so
`amount ≥ 50000` settles a test for `amount ≥ 10000`. More definitions to unfold
go in the list.
-/
syntax "behaviour" (" [" Lean.Parser.Tactic.simpLemma,* "]")? : tactic

theorem Behaviour.then_branch {α : Sort _} {c : Prop} [Decidable c] {a b : α} (h : c) :
    (if c then a else b) = a := by simp [h]

theorem Behaviour.else_branch {α : Sort _} {c : Prop} [Decidable c] {a b : α} (h : ¬c) :
    (if c then a else b) = b := by simp [h]

macro_rules
  | `(tactic| behaviour) =>
    `(tactic| (
        try dsimp only
        try simp (config := { failIfUnchanged := false })
          [behaviour, Alchemy.Program.pure_eq, Alchemy.Program.bind_eq, *]
        repeat' (first
          | done
          | (simp (disch := omega)
              [behaviour, Alchemy.Program.pure_eq, Alchemy.Program.bind_eq,
                Alchemy.Behaviour.then_branch, Alchemy.Behaviour.else_branch, *]
             try simp [behaviour, Alchemy.Program.pure_eq, Alchemy.Program.bind_eq, *]))))
  | `(tactic| behaviour [$lemmas,*]) =>
    `(tactic| (
        try dsimp only
        try simp (config := { failIfUnchanged := false })
          [behaviour, Alchemy.Program.pure_eq, Alchemy.Program.bind_eq, $lemmas,*, *]
        repeat' (first
          | done
          | (simp (disch := omega)
              [behaviour, Alchemy.Program.pure_eq, Alchemy.Program.bind_eq,
                Alchemy.Behaviour.then_branch, Alchemy.Behaviour.else_branch, $lemmas,*, *]
             try simp [behaviour, Alchemy.Program.pure_eq, Alchemy.Program.bind_eq, $lemmas,*, *]))))

end Alchemy
