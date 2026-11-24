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

namespace Alchemy
namespace Model

variable (m : Model)

theorem answerGo_split (c : m.signature.Call) (reply : m.signature.Reply c) :
    ∀ (fibers fibers' : List (Fiber m.signature)), m.answerGo c reply fibers = some fibers' →
      ∃ before f after k, fibers = before ++ f :: after ∧ f.program = .call c k ∧
        fibers' = before ++ { f with program := k reply } :: after := by
  intro fibers
  induction fibers with
  | nil => intro _ h; simp [answerGo] at h
  | cons f rest ih =>
    intro fibers' h
    unfold answerGo at h
    split at h
    · next c' k program =>
      split at h
      · next same =>
        subst same
        cases h
        exact ⟨[], f, rest, k, rfl, program, rfl⟩
      · obtain ⟨tail, found, rfl⟩ := Option.map_eq_some_iff.mp h
        obtain ⟨before, g, after, k', rfl, program', rfl⟩ := ih tail found
        exact ⟨f :: before, g, after, k', rfl, program', rfl⟩
    · obtain ⟨tail, found, rfl⟩ := Option.map_eq_some_iff.mp h
      obtain ⟨before, g, after, k', rfl, program', rfl⟩ := ih tail found
      exact ⟨f :: before, g, after, k', rfl, program', rfl⟩

/-- An answer the engine applies is one an outside system may give. -/
theorem answer_step (w w' : World m.signature) (c : m.signature.Call) (reply : m.signature.Reply c)
    (h : m.answer w c reply = some w') : m.Step w w' := by
  obtain ⟨fibers, found, rfl⟩ := Option.map_eq_some_iff.mp h
  obtain ⟨before, f, after, k, split, program, rfl⟩ := m.answerGo_split c reply _ _ found
  exact .answer w f before after c k reply split program

/-- Sending an offered command, and letting what follows run, stays within what the model can reach. -/
theorem play_send_reachable (fuel : Nat) (w : World m.signature) (s : Send m.signature.aggregates)
    (offered : m.offered s) (reach : m.Reachable w) : m.Reachable (m.play fuel w (.send s)) :=
  m.settle_reachable fuel _ (.step reach (.send w s offered))

/-- So does an outside system's answer. -/
theorem play_answer_reachable (fuel : Nat) (w : World m.signature) (c : m.signature.Call)
    (reply : m.signature.Reply c) (reach : m.Reachable w) :
    m.Reachable (m.play fuel w (.answer c reply)) := by
  show m.Reachable (match m.answer w c reply with
    | some w' => m.settle fuel w'
    | none => w)
  split
  · next w' h => exact m.settle_reachable fuel _ (.step reach (m.answer_step w w' c reply h))
  · exact reach

/-- Deciding, and letting what follows run, stays within what the model can reach. -/
theorem play_decide_reachable (m : Model) (fuel : Nat) (w : World m.signature)
    (d : Decision m.signature.aggregates) (mem : d ∈ m.decisions) (actor : d.Actor) (c : d.Command)
    (reach : m.Reachable w) : m.Reachable (m.play fuel w (.decide d actor c)) :=
  m.settle_reachable fuel _ (.step reach (.decide w d actor c mem))

end Model
end Alchemy

namespace Alchemy
namespace Model

variable (m : Model)

/-! ## Eventually

Safety says nothing bad happens. These say something good does: that a model
left to run comes to rest, and what is true of it once it has.
-/

/-- Nothing can go on without a caller, an outside answer or the clock. -/
def AtRest (w : World m.signature) : Prop := m.stepOnce w = none

theorem settle_atRest (fuel : Nat) (w : World m.signature) (rest : m.AtRest w) :
    m.settle fuel w = w := by
  cases fuel with
  | zero => rfl
  | succ fuel => simp [settle, show m.stepOnce w = none from rest]

/--
A model comes to rest. Given a measure that every step lowers, running on from
any world reaches one where nothing can go on, within as many steps as the measure.
-/
theorem comesToRest (measure : World m.signature → Nat)
    (lowers : ∀ w w', m.stepOnce w = some w' → measure w' < measure w) :
    ∀ fuel w, measure w ≤ fuel → m.AtRest (m.settle fuel w) := by
  intro fuel
  induction fuel with
  | zero =>
    intro w small
    show m.stepOnce w = none
    cases step : m.stepOnce w with
    | none => rfl
    | some w' => have := lowers w w' step; omega
  | succ fuel ih =>
    intro w small
    unfold settle
    cases step : m.stepOnce w with
    | none => exact step
    | some w' =>
      have := lowers w w' step
      exact ih w' (by omega)

/--
The same, for the worlds of some kind that steps stay within: the measure need
only fall there.
-/
theorem comesToRestWithin (within : World m.signature → Prop) (measure : World m.signature → Nat)
    (stays : ∀ w w', within w → m.stepOnce w = some w' → within w')
    (lowers : ∀ w w', within w → m.stepOnce w = some w' → measure w' < measure w) :
    ∀ fuel w, within w → measure w ≤ fuel → m.AtRest (m.settle fuel w) := by
  intro fuel
  induction fuel with
  | zero =>
    intro w inside small
    show m.stepOnce w = none
    cases step : m.stepOnce w with
    | none => rfl
    | some w' => have := lowers w w' inside step; omega
  | succ fuel ih =>
    intro w inside small
    unfold settle
    cases step : m.stepOnce w with
    | none => exact step
    | some w' =>
      have := lowers w w' inside step
      exact ih w' (stays w w' inside step) (by omega)

/-- Running on from `w`, the model comes to rest with `P` true. -/
def Eventually (w : World m.signature) (P : World m.signature → Prop) : Prop :=
  ∃ steps, m.AtRest (m.settle steps w) ∧ P (m.settle steps w)

/-- What is true of every world at rest that the model reaches is true eventually, if it comes to rest. -/
theorem eventually_of_rest {P : World m.signature → Prop} (measure : World m.signature → Nat)
    (lowers : ∀ w w', m.stepOnce w = some w' → measure w' < measure w)
    (atRest : ∀ w, m.Reachable w → m.AtRest w → P w)
    (w : World m.signature) (reach : m.Reachable w) : m.Eventually w P :=
  ⟨measure w, m.comesToRest measure lowers _ w (Nat.le_refl _),
    atRest _ (m.settle_reachable _ w reach) (m.comesToRest measure lowers _ w (Nat.le_refl _))⟩

/-- What holds of every reachable world holds eventually, from one that is already at rest. -/
theorem eventually_now {P : World m.signature → Prop} (w : World m.signature)
    (rest : m.AtRest w) (holds : P w) : m.Eventually w P :=
  ⟨0, rest, holds⟩

/--
A rule about the model once it has settled: every event delivered, and no
policy or saga part-way through or waiting.
-/
def OnceSettled (P : World m.signature → Prop) : Prop :=
  ∀ w, m.Reachable w → w.Settled → P w

/-- A rule that follows from an invariant once nothing is in flight holds once settled. -/
theorem onceSettled_of_invariant {I P : World m.signature → Prop}
    (initially : I (World.start m.signature)) (kept : ∀ w w', I w → m.Step w w' → I w')
    (settled : ∀ w, I w → w.Settled → P w) : m.OnceSettled P :=
  fun w reach rest => settled w (m.worldInvariant initially kept w reach) rest

end Model
end Alchemy
