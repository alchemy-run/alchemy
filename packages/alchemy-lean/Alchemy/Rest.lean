import Alchemy.Engine
import Alchemy.Attr

/-!
# Coming to rest, for models with policies

A policy that only calls outside and tells aggregates is *calm*: each step it
takes either ends it or sends one command. For a model whose policies are calm,
every running reaction is calm in every world it can reach. That pins down what
one step of the engine can do, which is what a measure needs to be shown to fall.
-/

namespace Alchemy

variable {σ : Signature}

/-- A reaction that only calls outside, tells aggregates, and ends. -/
inductive Calm : Program σ Unit → Prop where
  | done : Calm (.pure ())
  | tell (s : Send σ.aggregates) : Calm (.send s fun _ => .pure ())
  | call (c : σ.Call) (k : σ.Reply c → Program σ Unit) : (∀ reply, Calm (k reply)) → Calm (.call c k)

/-- Every reaction part-way through is calm. -/
def World.Calm (w : World σ) : Prop := ∀ f ∈ w.fibers, Alchemy.Calm f.program

theorem Calm.answered {c : σ.Call} {k : σ.Reply c → Program σ Unit} (calm : Calm (.call c k))
    (reply : σ.Reply c) : Calm (k reply) := by
  cases calm with
  | call _ _ each => exact each reply

namespace Model

variable (m : Model)

/-- One step of a calm reaction: it ends, or it sends one command and then ends. -/
theorem advance_calm {w w' : World m.signature} {f : Fiber m.signature} {fs : List (Fiber m.signature)}
    (calm : Calm f.program) (advanced : m.advance w f = some (w', fs)) :
    (f.program = .pure () ∧ fs = [] ∧ w'.inbox = w.inbox ∧ w'.fibers = w.fibers) ∨
      ∃ s, f.program = (.send s fun _ => .pure ()) ∧ w' = w.dispatch s ∧
        fs = [{ f with program := .pure () }] := by
  unfold advance at advanced
  cases calm' : f.program with
  | pure u =>
    rw [calm'] at advanced
    cases u
    simp only at advanced
    cases advanced
    refine .inl ⟨rfl, rfl, ?_, ?_⟩ <;> (unfold World.finish; split <;> rfl)
  | send s k =>
    rw [calm'] at calm advanced
    cases calm with
    | tell _ =>
      simp only at advanced
      cases advanced
      exact .inr ⟨s, rfl, rfl, rfl⟩
  | call c k => rw [calm'] at advanced; simp at advanced
  | fail _ => rw [calm'] at calm; cases calm
  | await _ => rw [calm'] at calm; cases calm
  | compensate _ _ => rw [calm'] at calm; cases calm
  | start _ _ _ => rw [calm'] at calm; cases calm
  | signal _ _ _ => rw [calm'] at calm; cases calm
  | schedule _ _ _ => rw [calm'] at calm; cases calm

/-- What the engine's fiber step is: one fiber, somewhere in the list, takes its step. -/
theorem tryFibers_split (w w' : World m.signature) :
    ∀ after before, m.tryFibers w before after = some w' →
      ∃ skipped f rest w'' fs, after = skipped ++ f :: rest ∧ m.advance w f = some (w'', fs) ∧
        w' = { w'' with fibers := before ++ skipped ++ fs ++ rest } := by
  intro after
  induction after with
  | nil => intro before h; simp [tryFibers] at h
  | cons f after ih =>
    intro before h
    unfold tryFibers at h
    split at h
    · next w'' fs adv =>
      cases h
      exact ⟨[], f, after, w'', fs, rfl, adv, by simp⟩
    · obtain ⟨skipped, g, rest, w'', fs, rfl, adv, rfl⟩ := ih (before ++ [f]) h
      exact ⟨f :: skipped, g, rest, w'', fs, rfl, adv, by simp⟩

theorem dispatch_fibers (w : World m.signature) (s : Send m.signature.aggregates) :
    (w.dispatch s).fibers = w.fibers := rfl

/-- If every policy is calm, one step of the engine keeps every reaction calm. -/
theorem stepOnce_calm (policies : ∀ p ∈ m.policies, ∀ history e, Calm (p.react history e))
    {w w' : World m.signature} (calm : w.Calm) (step : m.stepOnce w = some w') : w'.Calm := by
  unfold stepOnce at step
  split at step
  · next e rest _ =>
    cases step
    intro f mem
    simp only [react, List.mem_append, List.mem_map] at mem
    rcases mem with old | ⟨p, mem, rfl⟩
    · exact calm f old
    · exact policies p mem _ _
  · obtain ⟨skipped, f, rest, w'', fs, split, adv, rfl⟩ := m.tryFibers_split w w' _ _ step
    have fCalm : Calm f.program := calm f (by rw [split]; simp)
    intro g mem
    simp only [List.nil_append, List.mem_append] at mem
    rcases m.advance_calm fCalm adv with ⟨_, rfl, _, _⟩ | ⟨s, _, _, rfl⟩
    · rcases mem with (old | none) | old
      · exact calm g (by rw [split]; simp [old])
      · cases none
      · exact calm g (by rw [split]; simp [old])
    · rcases mem with (old | new) | old
      · exact calm g (by rw [split]; simp [old])
      · simp only [List.mem_singleton] at new; subst new; exact .done
      · exact calm g (by rw [split]; simp [old])

/-- If every policy is calm and nothing starts a saga, every reachable world is calm. -/
theorem reachable_calm (policies : ∀ p ∈ m.policies, ∀ history e, Calm (p.react history e))
    (w : World m.signature) (reach : m.Reachable w) : w.Calm := by
  induction reach with
  | start => intro f mem; cases mem
  | step _ step ih =>
    cases step with
    | send s _ => exact ih
    | decide d actor c _ => exact ih
    | deliver e before after inbox =>
      intro f mem
      simp only [react, List.mem_append, List.mem_map] at mem
      rcases mem with old | ⟨p, mem, rfl⟩
      · exact ih f old
      · exact policies p mem _ _
    | redeliver e _ =>
      intro f mem
      simp only [react, List.mem_append, List.mem_map] at mem
      rcases mem with old | ⟨p, mem, rfl⟩
      · exact ih f old
      · exact policies p mem _ _
    | advance f before after w' fs split adv =>
      have fCalm : Calm f.program := ih f (by rw [split]; simp)
      intro g mem
      simp only [List.mem_append] at mem
      rcases m.advance_calm fCalm adv with ⟨_, rfl, _, _⟩ | ⟨s, _, _, rfl⟩
      · rcases mem with (old | none) | old
        · exact ih g (by rw [split]; simp [old])
        · cases none
        · exact ih g (by rw [split]; simp [old])
      · rcases mem with (old | new) | old
        · exact ih g (by rw [split]; simp [old])
        · simp only [List.mem_singleton] at new; subst new; exact .done
        · exact ih g (by rw [split]; simp [old])
    | answer f before after c k reply split program =>
      have fCalm : Calm f.program := ih f (by rw [split]; simp)
      intro g mem
      simp only [List.mem_append, List.mem_cons] at mem
      rcases mem with old | rfl | old
      · exact ih g (by rw [split]; simp [old])
      · rw [program] at fCalm; exact fCalm.answered reply
      · exact ih g (by rw [split]; simp [old])
    | tick time _ => exact ih
    | fire due s before after _ _ => exact ih

/-! ## A measure that falls

Give each event a weight: at least one more than what the policies' reactions
to it weigh. Give each command a weight: at least what the events it records
weigh. Then every step of the engine lowers the total, so the model comes to rest.
-/

/-- What a reaction still has to do, given what each command weighs. -/
def weigh (send : Send m.signature.aggregates → Nat) : Program m.signature Unit → Nat
  | .pure _ => 1
  | .send s _ => 2 + send s
  | _ => 0

/-- Weights for a model's events and commands, with what makes them a measure. -/
structure Weights where
  event : (n : m.signature.aggregates.Name) → (m.signature.aggregates.of n).Event → Nat
  send : Send m.signature.aggregates → Nat
  /-- An event weighs more than the reactions to it. -/
  reacts : ∀ history (e : Emitted m.signature.aggregates),
    1 + (m.policies.map fun p => m.weigh send (p.react history e)).sum ≤ event e.source e.event
  /-- A command weighs at least what it records. -/
  emits : ∀ (n : m.signature.aggregates.Name) (ctx : Context (m.signature.aggregates.of n).Actor)
      (state : (m.signature.aggregates.of n).State) (command : (m.signature.aggregates.of n).Command)
      (es : List (m.signature.aggregates.of n).Event),
    (m.signature.aggregates.of n).decide ctx state command = .ok es →
      (es.map (event n)).sum ≤ send ⟨n, ctx.actor, command⟩

variable {m}

/-- What is left to do in a world: the events to deliver and the reactions under way. -/
def Weights.measure (weights : m.Weights) (w : World m.signature) : Nat :=
  (w.inbox.map fun e => weights.event e.source e.event).sum
    + (w.fibers.map fun f => m.weigh weights.send f.program).sum

theorem zipIdx_weight {α β : Type} (weight : α → Nat) (make : α × Nat → β) (value : β → Nat)
    (same : ∀ a i, value (make (a, i)) = weight a) (es : List α) (start : Nat) :
    (((es.zipIdx start).map make).map value).sum = (es.map weight).sum := by
  induction es generalizing start with
  | nil => rfl
  | cons e es ih =>
    have rest := ih (start + 1)
    simp only [List.zipIdx_cons, List.map_cons, List.sum_cons, same]
    omega

/-- Sending a command adds to the inbox no more than the command weighs. -/
theorem Weights.dispatch_inbox (weights : m.Weights) (w : World m.signature)
    (s : Send m.signature.aggregates) :
    ((w.dispatch s).inbox.map fun e => weights.event e.source e.event).sum
      ≤ (w.inbox.map fun e => weights.event e.source e.event).sum + weights.send s := by
  simp only [World.dispatch, World.lift, Recorded.dispatch]
  cases outcome : w.toRecorded.outcome w.now s with
  | error _ => simp
  | ok es =>
    simp only [Recorded.record, List.drop_left, List.map_append, List.sum_append]
    have bound : (es.map (weights.event s.to)).sum ≤ weights.send s :=
      weights.emits s.to ⟨s.actor, w.now⟩ _ s.command es outcome
    rw [zipIdx_weight (weights.event s.to) _ _ (fun _ _ => rfl)]
    omega

/-- Every step of the engine lowers the measure, in a world whose reactions are calm. -/
theorem Weights.lowers (weights : m.Weights) {w w' : World m.signature} (calm : w.Calm)
    (step : m.stepOnce w = some w') : weights.measure w' < weights.measure w := by
  unfold stepOnce at step
  split at step
  · next e rest inbox =>
    cases step
    have bound := weights.reacts (w.log.take e.seq) e
    simp only [Weights.measure, react, inbox, List.map_cons, List.sum_cons, List.map_append,
      List.sum_append, List.map_map]
    have same : ((m.policies.map fun p => m.weigh weights.send (p.react (w.log.take e.seq) e)).sum)
        = (List.map ((fun f => m.weigh weights.send f.program) ∘ fun p =>
            ({ owner := none, program := p.react (List.take e.seq w.log) e, undo := [] } :
              Fiber m.signature)) m.policies).sum := rfl
    omega
  · obtain ⟨skipped, f, rest, w'', fs, split, adv, rfl⟩ := m.tryFibers_split w w' _ _ step
    have fCalm : Calm f.program := calm f (by rw [split]; simp)
    rcases m.advance_calm fCalm adv with ⟨program, rfl, inbox, _⟩ | ⟨s, program, rfl, rfl⟩
    · simp only [Weights.measure, split, inbox, List.nil_append, List.append_nil, List.map_append,
        List.sum_append, List.map_cons, List.sum_cons, program, weigh]
      omega
    · have bound := weights.dispatch_inbox w s
      simp only [Weights.measure, split, List.nil_append, List.map_append, List.sum_append,
        List.map_cons, List.sum_cons, List.map_nil, List.sum_nil, program, weigh] at bound ⊢
      omega

/--
A model with calm policies and such weights comes to rest: from any world it
can reach, within as many steps as the measure, nothing can go on.
-/
theorem Weights.comesToRest (weights : m.Weights)
    (policies : ∀ p ∈ m.policies, ∀ history e, Calm (p.react history e))
    (w : World m.signature) (reach : m.Reachable w) :
    m.AtRest (m.settle (weights.measure w) w) :=
  m.comesToRestWithin World.Calm weights.measure
    (fun _ _ calm step => m.stepOnce_calm policies calm step)
    (fun _ _ calm step => weights.lowers calm step)
    _ w (m.reachable_calm policies w reach) (Nat.le_refl _)

/-- So what holds of every reachable world at rest holds eventually, from any reachable world. -/
theorem Weights.eventually (weights : m.Weights)
    (policies : ∀ p ∈ m.policies, ∀ history e, Calm (p.react history e))
    {P : World m.signature → Prop} (atRest : ∀ w, m.Reachable w → m.AtRest w → P w)
    (w : World m.signature) (reach : m.Reachable w) : m.Eventually w P :=
  ⟨weights.measure w, weights.comesToRest policies w reach,
    atRest _ (m.settle_reachable _ w reach) (weights.comesToRest policies w reach)⟩

/-! ## With sagas

A saga registers undos, starts runs, waits for signals and may fail. Its
programs branch on what it is answered, so a rank cannot be computed from one:
instead `Ranked p n` says the program can be shown to have rank at most `n`,
whatever it is answered. The same argument then goes through.
-/

variable (m)

/-- Weights for events and commands, as before, for a model whose reactions may do anything. -/
structure Ranking where
  event : (n : m.signature.aggregates.Name) → (m.signature.aggregates.of n).Event → Nat
  send : Send m.signature.aggregates → Nat
  /-- A command weighs at least what it records. -/
  emits : ∀ (n : m.signature.aggregates.Name) (ctx : Context (m.signature.aggregates.of n).Actor)
      (state : (m.signature.aggregates.of n).State) (command : (m.signature.aggregates.of n).Command)
      (es : List (m.signature.aggregates.of n).Event),
    (m.signature.aggregates.of n).decide ctx state command = .ok es →
      (es.map (event n)).sum ≤ send ⟨n, ctx.actor, command⟩

variable {m}

/-- The program has rank at most `t`: it takes at most that many steps, whatever it is answered. -/
inductive Ranked (ranking : m.Ranking) : Program m.signature Unit → Nat → Prop where
  | pure {t} : 1 ≤ t → Ranked ranking (.pure ()) t
  | fail {t} (failure) : 1 ≤ t → Ranked ranking (.fail failure) t
  | send {t n} (s) (k) : (∀ r, Ranked ranking (k r) n) → 2 + ranking.send s + n ≤ t →
      Ranked ranking (.send s k) t
  | call {t n} (c) (k) : (∀ r, Ranked ranking (k r) n) → n ≤ t → Ranked ranking (.call c k) t
  | await {t n} (k) : (∀ signal, Ranked ranking (k signal) n) → 1 + n ≤ t →
      Ranked ranking (.await k) t
  | compensate {t n b} (undo) (k) : (∀ failure, ranking.send (undo failure) ≤ b) →
      Ranked ranking k n → 3 + b + n ≤ t → Ranked ranking (.compensate undo k) t
  | start {t n j} (saga) (input) (k) : Ranked ranking k n →
      Ranked ranking (m.saga saga input) j → 1 + n + j ≤ t → Ranked ranking (.start saga input k) t
  | signal {t n} (saga) (told) (k) : Ranked ranking k n → 1 + n ≤ t →
      Ranked ranking (.signal saga told k) t
  | schedule {t n} (after) (s) (k) : Ranked ranking k n → 1 + n ≤ t →
      Ranked ranking (.schedule after s k) t

/-- What the undos a reaction has registered weigh. -/
inductive Undoing (ranking : m.Ranking) : List (m.signature.Failure → Send m.signature.aggregates) → Nat → Prop where
  | nil {t} : Undoing ranking [] t
  | cons {t n b} (undo) (rest) : (∀ failure, ranking.send (undo failure) ≤ b) →
      Undoing ranking rest n → 2 + b + n ≤ t → Undoing ranking (undo :: rest) t

/-- A reaction under way has rank at most `r`: its program and its undos together. -/
def Ranking.fiber (ranking : m.Ranking) (f : Fiber m.signature) (r : Nat) : Prop :=
  ∃ p u, Ranked ranking f.program p ∧ Undoing ranking f.undo u ∧ p + u ≤ r

/-- The reactions under way, each with a rank. -/
inductive Ranking.fibers (ranking : m.Ranking) : List (Fiber m.signature) → Nat → Prop where
  | nil : Ranking.fibers ranking [] 0
  | cons {f r fs n} : ranking.fiber f r → Ranking.fibers ranking fs n →
      Ranking.fibers ranking (f :: fs) (r + n)

theorem Ranking.fibers_append (ranking : m.Ranking) {a b : List (Fiber m.signature)} {x y : Nat}
    (ha : ranking.fibers a x) (hb : ranking.fibers b y) : ranking.fibers (a ++ b) (x + y) := by
  induction ha with
  | nil => simpa using hb
  | cons hf _ ih => rw [List.cons_append, Nat.add_assoc]; exact .cons hf ih

theorem Ranking.fibers_split (ranking : m.Ranking) {a : List (Fiber m.signature)}
    {f : Fiber m.signature} {b : List (Fiber m.signature)} {n : Nat}
    (h : ranking.fibers (a ++ f :: b) n) :
    ∃ x r y, ranking.fibers a x ∧ ranking.fiber f r ∧ ranking.fibers b y ∧ n = x + r + y := by
  induction a generalizing n with
  | nil =>
    cases h with
    | cons hf hb => exact ⟨0, _, _, .nil, hf, hb, by omega⟩
  | cons g a ih =>
    cases h with
    | cons hg rest =>
      obtain ⟨x, r, y, ha, hf, hb, rfl⟩ := ih rest
      exact ⟨_, r, y, .cons hg ha, hf, hb, by omega⟩

theorem Ranking.single (ranking : m.Ranking) {f : Fiber m.signature} {r : Nat}
    (ranked : ranking.fiber f r) : ranking.fibers [f] r := by
  simpa using Ranking.fibers.cons ranked .nil

/-- What is left to do in a world is at most `n`. -/
def Ranking.bounds (ranking : m.Ranking) (w : World m.signature) (n : Nat) : Prop :=
  ∃ fibers, ranking.fibers w.fibers fibers ∧
    (w.inbox.map fun e => ranking.event e.source e.event).sum + fibers ≤ n

theorem Ranking.dispatch_inbox (ranking : m.Ranking) (w : World m.signature)
    (s : Send m.signature.aggregates) :
    ((w.dispatch s).inbox.map fun e => ranking.event e.source e.event).sum
      ≤ (w.inbox.map fun e => ranking.event e.source e.event).sum + ranking.send s := by
  simp only [World.dispatch, World.lift, Recorded.dispatch]
  cases outcome : w.toRecorded.outcome w.now s with
  | error _ => simp
  | ok es =>
    simp only [Recorded.record, List.drop_left, List.map_append, List.sum_append]
    have bound : (es.map (ranking.event s.to)).sum ≤ ranking.send s :=
      ranking.emits s.to ⟨s.actor, w.now⟩ _ s.command es outcome
    rw [zipIdx_weight (ranking.event s.to) _ _ (fun _ _ => rfl)]
    omega

/-- One step of one reaction lowers what is left: its own rank and the inbox, against what replaces it. -/
theorem Ranking.advance (ranking : m.Ranking) {w w' : World m.signature} {f : Fiber m.signature}
    {fs : List (Fiber m.signature)} {r : Nat} (ranked : ranking.fiber f r)
    (advanced : m.advance w f = some (w', fs)) :
    ∃ after, ranking.fibers fs after ∧
      (w'.inbox.map fun e => ranking.event e.source e.event).sum + after
        < (w.inbox.map fun e => ranking.event e.source e.event).sum + r := by
  obtain ⟨p, u, program, undos, total⟩ := ranked
  have finished : ∀ owner status, (w.finish owner status).inbox = w.inbox := by
    intro owner status; unfold World.finish; split <;> rfl
  unfold Model.advance at advanced
  cases shape : f.program with
  | pure x =>
    rw [shape] at program advanced
    cases x
    cases program with
    | pure one =>
      simp only at advanced
      cases advanced
      exact ⟨0, .nil, by rw [finished]; omega⟩
  | fail failure =>
    rw [shape] at program advanced
    cases program with
    | fail _ one =>
      simp only at advanced
      cases undoList : f.undo with
      | nil =>
        rw [undoList] at advanced
        cases advanced
        exact ⟨0, .nil, by rw [finished]; omega⟩
      | cons undo rest =>
        rw [undoList] at advanced undos
        cases advanced
        cases undos with
        | cons _ _ small restUndos fits =>
          have grown := ranking.dispatch_inbox w (undo failure)
          have := small failure
          refine ⟨p + _, ranking.single (f := { f with program := .fail failure, undo := rest })
            ⟨p, _, .fail failure one, restUndos, Nat.le_refl _⟩, ?_⟩
          omega
  | send s k =>
    rw [shape] at program advanced
    cases program with
    | send _ _ each fits =>
      simp only at advanced
      cases advanced
      have grown := ranking.dispatch_inbox w s
      refine ⟨_ + u, ranking.single (f := { f with program := k (w.toRecorded.outcome w.now s) }) ⟨_, u, each _, undos, Nat.le_refl _⟩, ?_⟩
      omega
  | call c k => rw [shape] at advanced; simp at advanced
  | await k =>
    rw [shape] at program advanced
    cases program with
    | await _ each fits =>
      simp only at advanced
      cases owner : f.owner with
      | none => rw [owner] at advanced; simp at advanced
      | some saga =>
        rw [owner] at advanced
        simp only at advanced
        cases signals : w.signals saga with
        | nil => rw [signals] at advanced; simp at advanced
        | cons told rest =>
          rw [signals] at advanced
          cases advanced
          refine ⟨_ + u, ranking.single (f := { f with owner := some saga, program := k told })
            ⟨_, u, each told, undos, Nat.le_refl _⟩, ?_⟩
          simp only
          omega
  | compensate undo k =>
    rw [shape] at program advanced
    cases program with
    | compensate _ _ small rest fits =>
      simp only at advanced
      cases advanced
      refine ⟨_ + (2 + _ + u), ranking.single (f := { f with program := k, undo := undo :: f.undo }) ⟨_, 2 + _ + u, rest, .cons undo f.undo small undos (Nat.le_refl _), Nat.le_refl _⟩, ?_⟩
      omega
  | start saga input k =>
    rw [shape] at program advanced
    cases program with
    | start _ _ _ rest run fits =>
      simp only at advanced
      cases status : w.sagas saga with
      | notStarted =>
        rw [status] at advanced
        cases advanced
        refine ⟨(_ + u) + (_ + 0), .cons (f := { f with program := k })
          ⟨_, u, rest, undos, Nat.le_refl _⟩ (.cons
            (f := { owner := some saga, program := m.saga saga input, undo := [] })
            ⟨_, 0, run, .nil, Nat.le_refl _⟩ .nil), ?_⟩
        simp only
        omega
      | running | completed | failed _ =>
        rw [status] at advanced
        cases advanced
        refine ⟨_ + u, ranking.single (f := { f with program := k }) ⟨_, u, rest, undos, Nat.le_refl _⟩, ?_⟩
        omega
  | signal saga told k =>
    rw [shape] at program advanced
    cases program with
    | signal _ _ _ rest fits =>
      simp only at advanced
      cases advanced
      refine ⟨_ + u, ranking.single (f := { f with program := k }) ⟨_, u, rest, undos, Nat.le_refl _⟩, ?_⟩
      simp only
      omega
  | schedule after s k =>
    rw [shape] at program advanced
    cases program with
    | schedule _ _ _ rest fits =>
      simp only at advanced
      cases advanced
      refine ⟨_ + u, ranking.single (f := { f with program := k }) ⟨_, u, rest, undos, Nat.le_refl _⟩, ?_⟩
      simp only
      omega

/-- An event weighs more than the reactions to it, each of which has a rank. -/
def Ranking.Reacts (ranking : m.Ranking) : Prop :=
  ∀ history (e : Emitted m.signature.aggregates), ∃ total,
    ranking.fibers (m.policies.map fun p => { owner := none, program := p.react history e, undo := [] })
      total ∧ 1 + total ≤ ranking.event e.source e.event

theorem Ranking.bounds_mono (ranking : m.Ranking) {w : World m.signature} {n n' : Nat}
    (bound : ranking.bounds w n) (le : n ≤ n') : ranking.bounds w n' := by
  obtain ⟨fibers, ranked, fits⟩ := bound
  exact ⟨fibers, ranked, by omega⟩

/-- Every step of the engine lowers what is left to do. -/
theorem Ranking.lowers (ranking : m.Ranking) (reacts : ranking.Reacts) {w w' : World m.signature}
    {n : Nat} (bound : ranking.bounds w n) (step : m.stepOnce w = some w') :
    ∃ n', n' < n ∧ ranking.bounds w' n' := by
  obtain ⟨total, ranked, fits⟩ := bound
  unfold stepOnce at step
  split at step
  · next e rest inbox =>
    cases step
    obtain ⟨added, reactions, less⟩ := reacts (w.log.take e.seq) e
    refine ⟨n - 1, ?_, total + added, ranking.fibers_append ranked reactions, ?_⟩
    · simp only [inbox, List.map_cons, List.sum_cons] at fits; omega
    · simp only [react, inbox, List.map_cons, List.sum_cons] at fits ⊢
      omega
  · obtain ⟨skipped, f, rest, w'', fs, split, adv, rfl⟩ := m.tryFibers_split w w' _ _ step
    rw [split] at ranked
    obtain ⟨x, r, y, before, fiber, after, rfl⟩ := ranking.fibers_split ranked
    obtain ⟨replaced, new, less⟩ := ranking.advance fiber adv
    refine ⟨n - 1, by omega, x + replaced + y, ?_, ?_⟩
    · simpa [List.append_assoc] using
        ranking.fibers_append (ranking.fibers_append before new) after
    · simp only; omega

/-- So within as many steps as are left to do, nothing can go on. -/
theorem Ranking.rest (ranking : m.Ranking) (reacts : ranking.Reacts) :
    ∀ n (w : World m.signature), ranking.bounds w n → m.AtRest (m.settle n w) := by
  intro n
  induction n with
  | zero =>
    intro w bound
    show m.stepOnce w = none
    cases step : m.stepOnce w with
    | none => rfl
    | some w' => obtain ⟨n', less, _⟩ := ranking.lowers reacts bound step; omega
  | succ n ih =>
    intro w bound
    unfold settle
    cases step : m.stepOnce w with
    | none => exact step
    | some w' =>
      obtain ⟨n', less, bound'⟩ := ranking.lowers reacts bound step
      exact ih w' (ranking.bounds_mono bound' (by omega))

theorem Ranked.answered {ranking : m.Ranking} {c : m.signature.Call}
    {k : m.signature.Reply c → Program m.signature Unit} {t : Nat}
    (ranked : Ranked ranking (.call c k) t) (reply : m.signature.Reply c) :
    Ranked ranking (k reply) t := by
  cases ranked with
  | call _ _ each fits =>
    have : ∀ {p : Program m.signature Unit} {a b : Nat}, Ranked ranking p a → a ≤ b →
        Ranked ranking p b := by
      intro p a b h le
      induction h generalizing b with
      | pure one => exact .pure (by omega)
      | fail failure one => exact .fail failure (by omega)
      | send s k each fits _ => exact .send s k each (by omega)
      | call c k each fits _ => exact .call c k each (by omega)
      | await k each fits _ => exact .await k each (by omega)
      | compensate undo k small rest fits _ => exact .compensate undo k small rest (by omega)
      | start saga input k rest run fits _ _ => exact .start saga input k rest run (by omega)
      | signal saga told k rest fits _ => exact .signal saga told k rest (by omega)
      | schedule after s k rest fits _ => exact .schedule after s k rest (by omega)
    exact this (each reply) fits

/-- In every world the model can reach, every reaction under way has a rank. -/
theorem Ranking.reachable (ranking : m.Ranking) (reacts : ranking.Reacts)
    (w : World m.signature) (reach : m.Reachable w) : ∃ n, ranking.fibers w.fibers n := by
  induction reach with
  | start => exact ⟨0, .nil⟩
  | step _ step ih =>
    obtain ⟨n, ranked⟩ := ih
    cases step with
    | send s _ => exact ⟨n, ranked⟩
    | decide d actor c _ => exact ⟨n, ranked⟩
    | deliver e before after inbox =>
      obtain ⟨added, reactions, _⟩ := reacts (_ : List _) e
      exact ⟨_, ranking.fibers_append ranked reactions⟩
    | redeliver e _ =>
      obtain ⟨added, reactions, _⟩ := reacts (_ : List _) e
      exact ⟨_, ranking.fibers_append ranked reactions⟩
    | advance f before after w' fs split adv =>
      rw [split] at ranked
      obtain ⟨x, r, y, hb, fiber, ha, rfl⟩ := ranking.fibers_split ranked
      obtain ⟨replaced, new, _⟩ := ranking.advance fiber adv
      exact ⟨_, ranking.fibers_append (ranking.fibers_append hb new) ha⟩
    | answer f before after c k reply split program =>
      rw [split] at ranked
      obtain ⟨x, r, y, hb, ⟨p, u, prog, undos, total⟩, ha, rfl⟩ := ranking.fibers_split ranked
      rw [program] at prog
      exact ⟨_, ranking.fibers_append hb
        (.cons (f := { f with program := k reply }) ⟨p, u, prog.answered reply, undos, total⟩ ha)⟩
    | tick time _ => exact ⟨n, ranked⟩
    | fire due s before after _ _ => exact ⟨n, ranked⟩

/--
A model with such a ranking comes to rest. From any world it can reach, with
policies, sagas, undos and signals, after some number of steps nothing can go on.
-/
theorem Ranking.comesToRest (ranking : m.Ranking) (reacts : ranking.Reacts)
    (w : World m.signature) (reach : m.Reachable w) : ∃ steps, m.AtRest (m.settle steps w) := by
  obtain ⟨n, ranked⟩ := ranking.reachable reacts w reach
  exact ⟨_, ranking.rest reacts _ w ⟨n, ranked, Nat.le_refl _⟩⟩

/-- So what holds of every reachable world at rest holds eventually, from any reachable world. -/
theorem Ranking.eventually (ranking : m.Ranking) (reacts : ranking.Reacts)
    {P : World m.signature → Prop} (atRest : ∀ w, m.Reachable w → m.AtRest w → P w)
    (w : World m.signature) (reach : m.Reachable w) : m.Eventually w P := by
  obtain ⟨steps, rest⟩ := ranking.comesToRest reacts w reach
  exact ⟨steps, rest, atRest _ (m.settle_reachable _ w reach) rest⟩

/-! ## Ranks, found by the checker

The same rules with the rank of what follows worked out from the rank given, so
a proof never has to name one: `ranked` walks a program and spends its rank as
it goes.
-/

theorem Ranked.mono {ranking : m.Ranking} {p : Program m.signature Unit} {a b : Nat}
    (h : Ranked ranking p a) (le : a ≤ b) : Ranked ranking p b := by
  induction h generalizing b with
  | pure one => exact .pure (by omega)
  | fail failure one => exact .fail failure (by omega)
  | send s k each fits _ => exact .send s k each (by omega)
  | call c k each fits _ => exact .call c k each (by omega)
  | await k each fits _ => exact .await k each (by omega)
  | compensate undo k small rest fits _ => exact .compensate undo k small rest (by omega)
  | start saga input k rest run fits _ _ => exact .start saga input k rest run (by omega)
  | signal saga told k rest fits _ => exact .signal saga told k rest (by omega)
  | schedule after s k rest fits _ => exact .schedule after s k rest (by omega)

variable {ranking : m.Ranking} {t : Nat}

theorem Ranked.send' (s : Send m.signature.aggregates) (k)
    (each : ∀ r, Ranked ranking (k r) (t - (2 + ranking.send s))) (fits : 2 + ranking.send s + 1 ≤ t) :
    Ranked ranking (.send s k) t := .send s k each (by omega)

theorem Ranked.call' (c : m.signature.Call) (k) (each : ∀ r, Ranked ranking (k r) t) :
    Ranked ranking (.call c k) t := .call c k each (Nat.le_refl _)

theorem Ranked.await' (k : m.signature.Signal → Program m.signature Unit)
    (each : ∀ signal, Ranked ranking (k signal) (t - 1)) (fits : 2 ≤ t) :
    Ranked ranking (.await k) t := .await k each (by omega)

theorem Ranked.compensate' (undo : m.signature.Failure → Send m.signature.aggregates) (k)
    (s : Send m.signature.aggregates) (same : ∀ failure, undo failure = s)
    (rest : Ranked ranking k (t - (3 + ranking.send s))) (fits : 3 + ranking.send s + 1 ≤ t) :
    Ranked ranking (.compensate undo k) t :=
  .compensate undo k (b := ranking.send s) (fun failure => by rw [same]; exact Nat.le_refl _) rest
    (by omega)

theorem Ranked.start' {j : Nat} (saga) (input) (k)
    (run : Ranked ranking (m.saga saga input) j) (rest : Ranked ranking k (t - (1 + j)))
    (fits : 1 + j + 1 ≤ t) : Ranked ranking (.start saga input k) t :=
  .start saga input k rest run (by omega)

theorem Ranked.signal' (saga) (told) (k) (rest : Ranked ranking k (t - 1)) (fits : 2 ≤ t) :
    Ranked ranking (.signal saga told k) t := .signal saga told k rest (by omega)

theorem Ranked.schedule' (after) (s) (k) (rest : Ranked ranking k (t - 1)) (fits : 2 ≤ t) :
    Ranked ranking (.schedule after s k) t := .schedule after s k rest (by omega)

/-- A reaction with no undos registered, at its program's rank. -/
theorem Ranking.plain (ranking : m.Ranking) {program : Program m.signature Unit} {rank : Nat}
    (ranked : Ranked ranking program rank) :
    ranking.fiber { owner := none, program, undo := [] } rank :=
  ⟨rank, 0, ranked, .nil, Nat.le_refl _⟩

/-- The reactions to one event, each a program with a rank. -/
inductive Ranking.programs (ranking : m.Ranking) : List (Program m.signature Unit) → Nat → Prop where
  | nil : Ranking.programs ranking [] 0
  | cons {p r ps n} : Ranked ranking p r → Ranking.programs ranking ps n →
      Ranking.programs ranking (p :: ps) (r + n)

theorem Ranking.programs_fibers (ranking : m.Ranking) {ps : List (Program m.signature Unit)}
    {n : Nat} (h : ranking.programs ps n) :
    ranking.fibers (ps.map fun program => { owner := none, program, undo := [] }) n := by
  induction h with
  | nil => exact .nil
  | cons ranked _ ih => exact .cons (ranking.plain ranked) ih

/-- An event outweighs the reactions to it, once each reaction has a rank. -/
theorem Ranking.reacting (ranking : m.Ranking) {history} {e : Emitted m.signature.aggregates}
    {total : Nat} (ranked : ranking.programs (m.policies.map fun p => p.react history e) total)
    (fits : 1 + total ≤ ranking.event e.source e.event) :
    ∃ total, ranking.fibers
        (m.policies.map fun p => { owner := none, program := p.react history e, undo := [] }) total
      ∧ 1 + total ≤ ranking.event e.source e.event := by
  refine ⟨total, ?_, fits⟩
  simpa [List.map_map, Function.comp_def] using ranking.programs_fibers ranked

end Model

/-- Settles an inequality between a rank and what a step costs. -/
syntax "ranked_fits " ident : tactic

macro_rules
  | `(tactic| ranked_fits $ranking) =>
    `(tactic| first
      | decide
      | (simp [$ranking:ident]; done)
      | (simp [$ranking:ident]; omega)
      | omega)

/--
Proves that a program has the rank given: `ranked Bank.ranking [Bank.Payout.ranked]`.
It walks the program, spending the rank as it goes; the list is the ranks of
the sagas it may start.
-/
syntax "ranked " ident " [" term,* "]" : tactic

macro_rules
  | `(tactic| ranked $ranking [$sagas,*]) => do
    let again ← `(tactic| ranked $ranking [$sagas,*])
    let starts ← sagas.getElems.mapM fun saga =>
      `(tactic| (refine Alchemy.Model.Ranked.start' _ _ _ ($saga _ _) ?_ (by ranked_fits $ranking)
                 $again:tactic))
    let start ← if starts.isEmpty then `(tactic| fail "no saga's rank was given")
      else `(tactic| first $[| $starts:tactic]*)
    `(tactic| first
      | exact Alchemy.Model.Ranked.pure (by ranked_fits $ranking)
      | exact Alchemy.Model.Ranked.fail _ (by ranked_fits $ranking)
      | (refine Alchemy.Model.Ranked.send' _ _ (fun r => ?_) (by ranked_fits $ranking)
         first | $again:tactic | (cases r <;> $again:tactic))
      | (refine Alchemy.Model.Ranked.call' _ _ (fun r => ?_)
         first | $again:tactic | (cases r <;> $again:tactic))
      | (refine Alchemy.Model.Ranked.await' _ (fun r => ?_) (by ranked_fits $ranking)
         first | $again:tactic | (cases r <;> $again:tactic))
      | (refine Alchemy.Model.Ranked.compensate' _ _ _ (fun _ => rfl) ?_ (by ranked_fits $ranking)
         $again:tactic)
      | $start:tactic
      | (refine Alchemy.Model.Ranked.signal' _ _ _ ?_ (by ranked_fits $ranking)
         $again:tactic)
      | (refine Alchemy.Model.Ranked.schedule' _ _ _ ?_ (by ranked_fits $ranking)
         $again:tactic)
      | (split <;> $again:tactic))

end Alchemy
