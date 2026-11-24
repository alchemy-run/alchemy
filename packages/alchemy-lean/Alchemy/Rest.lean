import Alchemy.Engine

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

end Model

end Alchemy
