import Alchemy.Engine

/-!
# Models that call one another

A model calls systems outside it. When one of those systems is another model,
a `Link` says which calls it answers and how. The two then run together, and
everything proved of either still holds: a linked model is only ever answered
with something an outside system may answer, and only ever sent a command it
offers.
-/

namespace Alchemy

/-- How some of one model's calls are answered by another model. -/
structure Link (a b : Model) where
  /-- The command a call becomes for the other model, if the other model answers it. -/
  ask : a.signature.Call → Option (Send b.signature.aggregates)
  /-- What the caller is told, from what the other model answered. -/
  reply : (c : a.signature.Call) → (s : Send b.signature.aggregates) →
    Answer b.signature.aggregates s.to → a.signature.Reply c
  /-- A call only becomes a command the other model offers. -/
  offered : ∀ c s, ask c = some s → b.offered s := by intros; trivial

namespace Link

variable {a b : Model} (link : Link a b)

/-- The two models' worlds, side by side. -/
abbrev Worlds (_ : Link a b) := World a.signature × World b.signature

/-- One thing two linked models can do. -/
inductive Step : link.Worlds → link.Worlds → Prop where
  /-- The calling model takes a step of its own. -/
  | left (wa wa' wb) : a.Step wa wa' → Step (wa, wb) (wa', wb)
  /-- The answering model takes a step of its own. -/
  | right (wa wb wb') : b.Step wb wb' → Step (wa, wb) (wa, wb')
  /-- A waiting call is answered by the other model: it is sent the command, and its answer goes back. -/
  | call (wa wb) (f) (before after : List (Fiber a.signature)) (c) (k) (s) :
      wa.fibers = before ++ f :: after →
      f.program = .call c k →
      link.ask c = some s →
      Step (wa, wb)
        ({ wa with fibers := before ++
            { f with program := k (link.reply c s (wb.toRecorded.outcome wb.now s)) } :: after },
          wb.dispatch s)

/-- The worlds two linked models can get to. -/
inductive Reachable : link.Worlds → Prop where
  | start : Reachable (World.start a.signature, World.start b.signature)
  | step {w w'} : Reachable w → link.Step w w' → Reachable w'

/-- Linked, the calling model is still only where it could get to alone. -/
theorem reachable_left {w : link.Worlds} (reach : link.Reachable w) : a.Reachable w.1 := by
  induction reach with
  | start => exact .start
  | step _ step ih =>
    cases step with
    | left wa wa' wb h => exact .step ih h
    | right wa wb wb' h => exact ih
    | call wa wb f before after c k s fibers program asked =>
      exact .step ih (.answer wa f before after c k _ fibers program)

/-- And so is the answering model. -/
theorem reachable_right {w : link.Worlds} (reach : link.Reachable w) : b.Reachable w.2 := by
  induction reach with
  | start => exact .start
  | step _ step ih =>
    cases step with
    | left wa wa' wb h => exact ih
    | right wa wb wb' h => exact .step ih h
    | call wa wb f before after c k s fibers program asked =>
      exact .step ih (.send wb s (link.offered c s asked))

/--
So whatever is proved of each model alone holds of the two linked: a rule of
the caller's worlds and a rule of the answerer's worlds hold together.
-/
theorem both {P : World a.signature → Prop} {Q : World b.signature → Prop}
    (left : ∀ w, a.Reachable w → P w) (right : ∀ w, b.Reachable w → Q w)
    {w : link.Worlds} (reach : link.Reachable w) : P w.1 ∧ Q w.2 :=
  ⟨left _ (link.reachable_left reach), right _ (link.reachable_right reach)⟩

/-- A rule about the two together: it holds at the start, and no step breaks it. -/
theorem invariant {rule : link.Worlds → Prop}
    (initially : rule (World.start a.signature, World.start b.signature))
    (kept : ∀ w w', link.Reachable w → rule w → link.Step w w' → rule w') :
    ∀ w, link.Reachable w → rule w := by
  intro w reach
  induction reach with
  | start => exact initially
  | step before step ih => exact kept _ _ before ih step

/-! ## Running two linked models -/

def fuel : Nat := 1000

/-- The first waiting call the other model answers is answered by it. -/
def answerNext (w : link.Worlds) : Option link.Worlds :=
  (a.waiting w.1).findSome? fun c =>
    match link.ask c with
    | none => none
    | some s =>
      let answer := w.2.toRecorded.outcome w.2.now s
      (a.answer w.1 c (link.reply c s answer)).map fun wa =>
        (a.settle fuel wa, b.settle fuel (w.2.dispatch s))

/-- Answers linked calls until none is waiting, or the fuel runs out. -/
def settle : Nat → link.Worlds → link.Worlds
  | 0, w => w
  | calls + 1, w =>
    match link.answerNext w with
    | none => w
    | some w' => settle calls w'

/-- A move of the calling model, then everything that follows in both. -/
def play (w : link.Worlds) (move : Model.Move a) : link.Worlds :=
  link.settle 100 (a.play fuel w.1 move, w.2)

/-- Both worlds after every move of the calling model, from the start. -/
def run (moves : List (Model.Move a)) : link.Worlds :=
  moves.foldl link.play (World.start a.signature, World.start b.signature)

end Link

end Alchemy
