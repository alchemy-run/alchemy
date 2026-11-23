import Alchemy.Engine

/-!
A search for the sequence of moves that breaks a rule. Where a proof says a
rule holds for ever, this says it holds in every sequence tried, and when it
does not, it gives the sequence.
-/
namespace Alchemy
namespace Model

variable (m : Model)

/-- The first sequence of at most `depth` moves after which `rule` fails, by where each move is in `moves`. -/
def breaks (moves : List (Move m)) (rule : World m.signature → Bool) (fuel : Nat := 1000) :
    Nat → World m.signature → Option (List Nat)
  | 0, w => if rule w then none else some []
  | depth + 1, w =>
    if rule w then
      (moves.zipIdx).findSome? fun (move, i) =>
        (breaks moves rule fuel depth (m.play fuel w move)).map (i :: ·)
    else some []

/-- The shortest sequence of at most `depth` moves that breaks `rule`, if there is one. -/
def counterexample (moves : List (Move m)) (depth : Nat) (rule : World m.signature → Bool) :
    Option (List Nat) :=
  (List.range (depth + 1)).findSome? fun d => m.breaks moves rule 1000 d (World.start m.signature)

/-- A rule holds after every sequence of at most `depth` of the moves, once the model has settled. -/
def checked (moves : List (Move m)) (depth : Nat) (rule : World m.signature → Bool) : Bool :=
  (m.breaks moves rule 1000 depth (World.start m.signature)).isNone

/-- Some sequence of at most `depth` of the moves gets to a world where `goal` holds. -/
def sometimes (moves : List (Move m)) (depth : Nat) (goal : World m.signature → Bool) : Bool :=
  (m.breaks moves (fun w => !goal w) 1000 depth (World.start m.signature)).isSome

end Model
end Alchemy
