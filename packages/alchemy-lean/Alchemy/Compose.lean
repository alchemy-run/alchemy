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

namespace Alchemy

/--
Any number of models that call one another. For each model, `ask` says which of
its calls another model answers and with what command, and `reply` what the
caller is told.
-/
structure Network (ι : Type) [DecidableEq ι] (model : ι → Model) where
  ask : (i : ι) → (model i).signature.Call →
    Option ((j : ι) × Send (model j).signature.aggregates)
  reply : (i : ι) → (c : (model i).signature.Call) → (j : ι) →
    (s : Send (model j).signature.aggregates) → Answer (model j).signature.aggregates s.to →
    (model i).signature.Reply c
  /-- A call only becomes a command the answering model offers. -/
  offered : ∀ i c j s, ask i c = some ⟨j, s⟩ → (model j).offered s := by intros; trivial
  /--
  The models, for running the network. A run looks for a waiting call among them
  in this order. Proofs do not depend on it: `Step` lets any call be answered next.
  -/
  parts : List ι := []

namespace Network

variable {ι : Type} [DecidableEq ι] {model : ι → Model} (net : Network ι model)

/-- Every model's world. -/
abbrev Worlds (_ : Network ι model) := (i : ι) → World (model i).signature

/-- The worlds with one model's replaced. -/
def set (w : net.Worlds) (i : ι) (wi : World (model i).signature) : net.Worlds :=
  fun k => if h : i = k then h ▸ wi else w k

@[simp] theorem set_same (w : net.Worlds) (i : ι) (wi : World (model i).signature) :
    net.set w i wi i = wi := by simp [set]

theorem set_other (w : net.Worlds) (i k : ι) (wi : World (model i).signature) (ne : i ≠ k) :
    net.set w i wi k = w k := by simp [set, ne]

/-- One thing a network of models can do. -/
inductive Step : net.Worlds → net.Worlds → Prop where
  /-- One model takes a step of its own. -/
  | own (w) (i) (wi') : (model i).Step (w i) wi' → Step w (net.set w i wi')
  /-- A waiting call is answered by another model: it is sent the command, and its answer goes back. -/
  | call (w) (i) (f) (before after : List (Fiber (model i).signature)) (c) (k) (j) (s) :
      (w i).fibers = before ++ f :: after →
      f.program = .call c k →
      net.ask i c = some ⟨j, s⟩ →
      i ≠ j →
      Step w (net.set
        (net.set w i { w i with fibers := before ++
          { f with program := k (net.reply i c j s ((w j).toRecorded.outcome (w j).now s)) } :: after })
        j ((w j).dispatch s))

/-- The worlds a network can get to. -/
inductive Reachable : net.Worlds → Prop where
  | start : Reachable fun i => World.start (model i).signature
  | step {w w'} : Reachable w → net.Step w w' → Reachable w'

/-- In a network, each model is still only where it could get to alone. -/
theorem reachable_each {w : net.Worlds} (reach : net.Reachable w) (k : ι) :
    (model k).Reachable (w k) := by
  induction reach generalizing k with
  | start => exact .start
  | step _ step ih =>
    cases step with
    | own i wi' h =>
      by_cases same : i = k
      · subst same; rw [set_same]; exact .step (ih i) h
      · rw [net.set_other _ _ _ _ same]; exact ih k
    | call i f before after c cont j s fibers program asked differ =>
      by_cases toK : j = k
      · subst toK
        rw [set_same]
        exact .step (ih j) (.send _ s (net.offered i c j s asked))
      · rw [net.set_other _ _ _ _ toK]
        by_cases fromK : i = k
        · subst fromK
          rw [set_same]
          exact .step (ih i) (.answer _ f before after c cont _ fibers program)
        · rw [net.set_other _ _ _ _ fromK]; exact ih k

/--
So whatever is proved of each model alone holds of all of them together: a rule
for each model's worlds holds of every model in every world the network reaches.
-/
theorem all {P : (i : ι) → World (model i).signature → Prop}
    (each : ∀ i w, (model i).Reachable w → P i w) {w : net.Worlds} (reach : net.Reachable w) :
    ∀ i, P i (w i) :=
  fun i => each i _ (net.reachable_each reach i)

/-! ## Running a network -/

/-- The first waiting call that another model answers is answered by it. -/
def answerNext (w : net.Worlds) : Option net.Worlds :=
  net.parts.findSome? fun i =>
    ((model i).waiting (w i)).findSome? fun c =>
      match net.ask i c with
      | none => none
      | some ⟨j, s⟩ =>
        if i = j then none
        else
          let answer := (w j).toRecorded.outcome (w j).now s
          ((model i).answer (w i) c (net.reply i c j s answer)).map fun wi =>
            net.set (net.set w i ((model i).settle Link.fuel wi)) j
              ((model j).settle Link.fuel ((w j).dispatch s))

/-- Answers calls between the models until none is waiting, or the fuel runs out. -/
def settle : Nat → net.Worlds → net.Worlds
  | 0, w => w
  | calls + 1, w =>
    match net.answerNext w with
    | none => w
    | some w' => settle calls w'

/-- A move of one model, then everything that follows in all of them. -/
def play (w : net.Worlds) (move : (i : ι) × Model.Move (model i)) : net.Worlds :=
  net.settle 100 (net.set w move.1 ((model move.1).play Link.fuel (w move.1) move.2))

/-- Every model's world after every move, from the start. -/
def run (moves : List ((i : ι) × Model.Move (model i))) : net.Worlds :=
  moves.foldl net.play fun i => World.start (model i).signature

/-! ## A run is within what the network can reach

The run picks one order in which to answer waiting calls. Whichever it picks,
it only takes steps the network can take. So every theorem about the worlds a
network can reach holds of every run, whatever the order.
-/

theorem set_set (w : net.Worlds) (i : ι) (a b : World (model i).signature) :
    net.set (net.set w i a) i b = net.set w i b := by
  funext k
  by_cases same : i = k
  · subst same; simp
  · simp [set, same]

theorem set_self (w : net.Worlds) (i : ι) : net.set w i (w i) = w := by
  funext k
  by_cases same : i = k
  · subst same; simp
  · simp [set, same]

theorem set_comm (w : net.Worlds) (i j : ι) (a : World (model i).signature)
    (b : World (model j).signature) (ne : i ≠ j) :
    net.set (net.set w i a) j b = net.set (net.set w j b) i a := by
  funext k
  by_cases toI : i = k
  · subst toI
    have : ¬j = i := fun h => ne h.symm
    simp [set, this]
  · by_cases toJ : j = k
    · subst toJ; simp [set, toI]
    · simp [set, toI, toJ]

/-- One model running on by its own steps keeps the network within what it can reach. -/
theorem reachable_runs {w : net.Worlds} (reach : net.Reachable w) (i : ι)
    {wi' : World (model i).signature} (runs : (model i).Runs (w i) wi') :
    net.Reachable (net.set w i wi') := by
  induction runs with
  | refl => rw [set_self]; exact reach
  | step _ step ih =>
    have := Reachable.step ih (.own _ i _ (by rw [set_same]; exact step))
    rwa [set_set] at this

/-- Answering the next waiting call keeps the network within what it can reach. -/
theorem answerNext_reachable {w w' : net.Worlds} (reach : net.Reachable w)
    (next : net.answerNext w = some w') : net.Reachable w' := by
  unfold answerNext at next
  obtain ⟨i, _, next⟩ := List.exists_of_findSome?_eq_some next
  obtain ⟨c, _, next⟩ := List.exists_of_findSome?_eq_some next
  cases asked : net.ask i c with
  | none => simp [asked] at next
  | some target =>
    obtain ⟨j, s⟩ := target
    simp only [asked] at next
    by_cases same : i = j
    · simp [same] at next
    · simp only [same, ite_false] at next
      obtain ⟨wi, answered, rfl⟩ := Option.map_eq_some_iff.mp next
      obtain ⟨fibers, found, rfl⟩ := Option.map_eq_some_iff.mp answered
      obtain ⟨before, f, after, k, split, program, rfl⟩ :=
        (model i).answerGo_split c _ _ _ found
      have called := Reachable.step reach (.call w i f before after c k j s split program asked same)
      -- then each of the two settles, by its own steps
      have settledJ := net.reachable_runs called j
        (wi' := (model j).settle Link.fuel ((w j).dispatch s))
        (by rw [set_same]; exact (model j).settle_runs _ _)
      rw [set_set, net.set_comm _ i j _ _ same] at settledJ
      have settledI := net.reachable_runs settledJ i
        (by rw [set_same]; exact (model i).settle_runs Link.fuel _)
      rw [set_set, net.set_comm _ j i _ _ (fun h => same h.symm)] at settledI
      exact settledI

theorem settle_reachable (calls : Nat) : ∀ {w : net.Worlds}, net.Reachable w →
    net.Reachable (net.settle calls w) := by
  induction calls with
  | zero => intro w reach; exact reach
  | succ calls ih =>
    intro w reach
    unfold settle
    cases next : net.answerNext w with
    | none => exact reach
    | some w' => exact ih (net.answerNext_reachable reach next)

/--
A run of offered commands is within what the network can reach. So whatever is
proved of every reachable world holds of the run, in whatever order it answered.
-/
theorem run_reachable (commands : List ((i : ι) × Send (model i).signature.aggregates))
    (offered : ∀ command ∈ commands, (model command.1).offered command.2) :
    net.Reachable (net.run (commands.map fun command => ⟨command.1, .send command.2⟩)) := by
  unfold run
  suffices ∀ (w : net.Worlds), net.Reachable w →
      net.Reachable ((commands.map fun command =>
        (⟨command.1, .send command.2⟩ : (i : ι) × Model.Move (model i))).foldl net.play w) from
    this _ .start
  induction commands with
  | nil => intro w reach; exact reach
  | cons command rest ih =>
    intro w reach
    refine ih (fun c mem => offered c (List.mem_cons_of_mem _ mem)) _ ?_
    exact net.settle_reachable _ (net.reachable_runs reach command.1
      ((model command.1).play_send_runs _ _ _ (offered command List.mem_cons_self)))

end Network

end Alchemy
