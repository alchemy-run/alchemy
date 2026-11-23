import Alchemy.Model

/-!
An engine that runs a model in memory: it picks one order for what `Step`
leaves open (oldest event first, then the first fiber that can go on), so a
model can be run, tested and searched. Everything it does is a `Step`.
-/
namespace Alchemy
namespace Model

variable (m : Model)

/-- The first fiber that can take a step takes it. -/
def tryFibers (w : World m.signature) :
    List (Fiber m.signature) → List (Fiber m.signature) → Option (World m.signature)
  | _, [] => none
  | before, f :: after =>
    match m.advance w f with
    | some (w', fs) => some { w' with fibers := before ++ fs ++ after }
    | none => tryFibers w (before ++ [f]) after

/-- One step, if anything can go on without a caller, an answer or the clock. -/
def stepOnce (w : World m.signature) : Option (World m.signature) :=
  match w.inbox with
  | e :: rest => some (m.react { w with inbox := rest } e)
  | [] => m.tryFibers w [] w.fibers

/-- Runs until nothing can go on, or the fuel runs out. -/
def settle (fuel : Nat) (w : World m.signature) : World m.signature :=
  match fuel with
  | 0 => w
  | fuel + 1 =>
    match m.stepOnce w with
    | none => w
    | some w' => settle fuel w'

theorem tryFibers_step (w w' : World m.signature) :
    ∀ after before, w.fibers = before ++ after → m.tryFibers w before after = some w' →
      m.Step w w' := by
  intro after
  induction after with
  | nil => intro before _ h; simp [tryFibers] at h
  | cons f after ih =>
    intro before fibers h
    unfold tryFibers at h
    split at h
    · next w'' fs adv =>
      cases h
      exact .advance w f before after w'' fs fibers adv
    · exact ih (before ++ [f]) (by simpa using fibers) h

theorem stepOnce_step (w w' : World m.signature) (h : m.stepOnce w = some w') : m.Step w w' := by
  unfold stepOnce at h
  split at h
  · next e rest inbox =>
    cases h
    exact .deliver w e [] rest (by simpa using inbox)
  · exact m.tryFibers_step w w' w.fibers [] (by simp) h

/-- What the engine reaches, the deployed model can reach. -/
theorem settle_reachable (fuel : Nat) : ∀ w, m.Reachable w → m.Reachable (m.settle fuel w) := by
  induction fuel with
  | zero => intro w h; exact h
  | succ fuel ih =>
    intro w h
    unfold settle
    split
    · exact h
    · next w' one => exact ih w' (.step h (m.stepOnce_step w w' one))

/-- The calls waiting for an outside system's answer, oldest first. -/
def waiting (w : World m.signature) : List m.signature.Call :=
  w.fibers.filterMap fun f =>
    match f.program with
    | .call c _ => some c
    | _ => none

def answerGo (c : m.signature.Call) (reply : m.signature.Reply c) :
    List (Fiber m.signature) → Option (List (Fiber m.signature))
  | [] => none
  | f :: rest =>
    match f.program with
    | .call c' k =>
      if h : c = c' then some ({ f with program := k (h ▸ reply) } :: rest)
      else (answerGo c reply rest).map (f :: ·)
    | _ => (answerGo c reply rest).map (f :: ·)

/-- Answers the oldest waiting call that is this one. -/
def answer (w : World m.signature) (c : m.signature.Call) (reply : m.signature.Reply c) :
    Option (World m.signature) :=
  (m.answerGo c reply w.fibers).map fun fibers => { w with fibers }

/-- Moves the clock on, and sends every scheduled command that is now due. -/
def pass (fuel : Nat) (w : World m.signature) (duration : Time) : World m.signature :=
  let now := w.now + duration
  let due := w.schedule.filter fun x => x.1 ≤ now
  let later := w.schedule.filter fun x => ¬ x.1 ≤ now
  due.foldl (fun w x => m.settle fuel (w.dispatch x.2)) { w with now := now, schedule := later }

/-- What a caller, an outside system or the clock does to a model. -/
inductive Move (m : Model) where
  | send (s : Send m.signature.aggregates)
  | decide (d : Decision m.signature.aggregates) (actor : d.Actor) (c : d.Command)
  | answer (c : m.signature.Call) (reply : m.signature.Reply c)
  | pass (duration : Time)
  /-- A fault: the event at this place in the log reaches the policies again. -/
  | redeliver (seq : Nat)

/-- The world after a move, once everything that follows from it has run. -/
def play (fuel : Nat) (w : World m.signature) : Move m → World m.signature
  | .send s => m.settle fuel (w.dispatch s)
  | .decide d actor c => m.settle fuel (w.decide d actor c)
  | .answer c reply =>
    match m.answer w c reply with
    | some w' => m.settle fuel w'
    | none => w
  | .pass duration => m.pass fuel w duration
  | .redeliver seq =>
    match w.log[seq]? with
    | some e => m.settle fuel (m.react w e)
    | none => w

/-- The world after every move, from the start. -/
def run (moves : List (Move m)) (fuel : Nat := 1000) : World m.signature :=
  moves.foldl (m.play fuel) (World.start m.signature)

end Model
end Alchemy
