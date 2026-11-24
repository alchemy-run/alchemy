import Alchemy.Model

/-!
# Commands only a reaction sends

Some commands are not for callers: a shipment is scheduled because an order was
paid, not because somebody asked. `Model.caused` proves a rule that depends on
that. A command is justified by what is recorded; every reaction sends only
justified commands; callers are offered only commands that keep the rule
anyway. Then the rule holds in every world the model can reach.
-/
namespace Alchemy

variable {σ : Signature} {α : Type}

/-- Every command a program may send, schedule or register to undo, whatever it is answered. -/
inductive Program.Only (ok : Send σ.aggregates → Prop) : Program σ α → Prop where
  | pure (a) : Only ok (.pure a)
  | fail (failure) : Only ok (.fail failure)
  | send (s k) : ok s → (∀ r, Only ok (k r)) → Only ok (.send s k)
  | call (c k) : (∀ r, Only ok (k r)) → Only ok (.call c k)
  | await (k) : (∀ r, Only ok (k r)) → Only ok (.await k)
  | compensate (u k) : (∀ failure, ok (u failure)) → Only ok k → Only ok (.compensate u k)
  | start (saga input k) : Only ok k → Only ok (.start saga input k)
  | signal (saga signal k) : Only ok k → Only ok (.signal saga signal k)
  | schedule (after s k) : ok s → Only ok k → Only ok (.schedule after s k)

theorem Program.Only.mono {ok ok' : Send σ.aggregates → Prop} (wider : ∀ s, ok s → ok' s)
    {p : Program σ α} (only : p.Only ok) : p.Only ok' := by
  induction only with
  | pure a => exact .pure a
  | fail failure => exact .fail failure
  | send s k h _ ih => exact .send s k (wider s h) ih
  | call c k _ ih => exact .call c k ih
  | await k _ ih => exact .await k ih
  | compensate u k h _ ih => exact .compensate u k (fun failure => wider _ (h failure)) ih
  | start saga input k _ ih => exact .start saga input k ih
  | signal saga signal k _ ih => exact .signal saga signal k ih
  | schedule after s k h _ ih => exact .schedule after s k (wider s h) ih

namespace Program.Only

variable {ok : Send σ.aggregates → Prop} {β : Type}

/-- One step after another sends only what each may. -/
theorem bind {p : Program σ α} {f : α → Program σ β} (first : p.Only ok)
    (rest : ∀ a, (f a).Only ok) : (p.bind f).Only ok := by
  induction first with
  | pure a => exact rest a
  | fail failure => exact .fail failure
  | send s k h _ ih => exact .send s _ h ih
  | call c k _ ih => exact .call c _ ih
  | await k _ ih => exact .await _ ih
  | compensate u k h _ ih => exact .compensate u _ h ih
  | start saga input k _ ih => exact .start saga input _ ih
  | signal saga signal k _ ih => exact .signal saga signal _ ih
  | schedule after s k h _ ih => exact .schedule after s _ h ih

theorem bind' {p : Program σ α} {f : α → Program σ β} (first : p.Only ok)
    (rest : ∀ a, (f a).Only ok) : (p >>= f).Only ok := bind first rest

theorem pure' (a : α) : (Pure.pure a : Program σ α).Only ok := .pure a

theorem tell {s : Send σ.aggregates} (h : ok s) : (Program.tell s).Only ok :=
  .send s _ h fun _ => .pure ()

theorem ask {s : Send σ.aggregates} (h : ok s) : (Program.ask s).Only ok :=
  .send s _ h fun r => .pure r

theorem step {s : Send σ.aggregates} {explain} (h : ok s) : (Program.step s explain).Only ok :=
  .send s _ h fun r => by cases r <;> first | exact .pure () | exact .fail _

theorem request (c : σ.Call) : (Program.request c).Only ok := .call c _ fun r => .pure r

theorem awaitSignal : (Program.awaitSignal : Program σ σ.Signal).Only ok := .await _ fun r => .pure r

theorem undoWith {undo : σ.Failure → Send σ.aggregates} (h : ∀ failure, ok (undo failure)) :
    (Program.undoWith undo).Only ok := .compensate undo _ h (.pure ())

theorem startSaga (saga : σ.Saga) (input : σ.SagaInput) : (Program.startSaga saga input).Only ok :=
  .start saga input _ (.pure ())

theorem signalSaga (saga : σ.Saga) (signal : σ.Signal) : (Program.signalSaga saga signal).Only ok :=
  .signal saga signal _ (.pure ())

theorem later {after : Time} {s : Send σ.aggregates} (h : ok s) : (Program.later after s).Only ok :=
  .schedule after s _ h (.pure ())

end Program.Only

namespace Model

variable (m : Model)

/-- What `caused` asks: a rule, what justifies a command, and that reactions send only justified ones. -/
structure Caused (rule : Recorded m.signature.aggregates → Prop)
    (justified : Recorded m.signature.aggregates → Send m.signature.aggregates → Prop) : Prop where
  initially : rule (.start m.signature.aggregates)
  /-- What justifies a command still does once more is recorded. -/
  lasting : ∀ r now s s', justified r s' → justified (r.dispatch now s) s'
  /-- A command callers are offered keeps the rule. -/
  offered : ∀ r now s, m.offered s → rule r → rule (r.dispatch now s)
  /-- A justified command keeps the rule. -/
  kept : ∀ r now s, justified r s → rule r → rule (r.dispatch now s)
  /-- A policy reacting to a recorded event sends only justified commands. -/
  policies : ∀ p ∈ m.policies, ∀ r history e, e ∈ r.log → (p.react history e).Only (justified r)
  /-- So does every saga. -/
  sagas : ∀ r saga input, (m.saga saga input).Only (justified r)

/-- Everything that could still send a command is justified in sending it. -/
structure Caused.Holds {m : Model} (justified : Recorded m.signature.aggregates →
    Send m.signature.aggregates → Prop) (w : World m.signature) : Prop where
  inbox : ∀ e ∈ w.inbox, e ∈ w.log
  programs : ∀ f ∈ w.fibers, f.program.Only (justified w.toRecorded)
  undos : ∀ f ∈ w.fibers, ∀ u ∈ f.undo, ∀ failure, justified w.toRecorded (u failure)
  schedule : ∀ x ∈ w.schedule, justified w.toRecorded x.2

end Model

namespace Recorded

variable {g : Aggregates}

/-- A command only adds to the log. -/
theorem log_dispatch (r : Recorded g) (now : Time) (s : Send g) :
    ∃ more, (r.dispatch now s).log = r.log ++ more := by
  rcases r.dispatch_cases now s with same | ⟨es, _, recorded⟩
  · exact ⟨[], by rw [same, List.append_nil]⟩
  · rw [recorded]; exact r.log_subset_record _ _ _ _

end Recorded

namespace Model

variable {m : Model} {rule : Recorded m.signature.aggregates → Prop}
  {justified : Recorded m.signature.aggregates → Send m.signature.aggregates → Prop}

/-- Sending a command keeps everything justified: its new events wait, and what was justified still is. -/
theorem Caused.Holds.dispatch (caused : m.Caused rule justified) {w : World m.signature}
    (holds : Caused.Holds justified w) (s : Send m.signature.aggregates) :
    Caused.Holds justified (w.dispatch s) := by
  obtain ⟨more, grew⟩ := w.toRecorded.log_dispatch w.now s
  have log : (w.dispatch s).log = w.log ++ more := grew
  have inbox : (w.dispatch s).inbox = w.inbox ++ more := by
    show w.inbox ++ (w.toRecorded.dispatch w.now s).log.drop w.log.length = _
    rw [grew, List.drop_left]
  refine ⟨?_, ?_, ?_, ?_⟩
  · intro e mem
    rw [inbox] at mem
    rw [log]
    rcases List.mem_append.mp mem with old | new
    · exact List.mem_append_left _ (holds.inbox e old)
    · exact List.mem_append_right _ new
  · intro f mem
    exact (holds.programs f mem).mono fun s' => caused.lasting _ _ s s'
  · intro f mem u inUndo failure
    exact caused.lasting _ _ s _ (holds.undos f mem u inUndo failure)
  · intro x mem
    exact caused.lasting _ _ s _ (holds.schedule x mem)

/-- A change that records nothing, and leaves only justified programs, keeps everything justified. -/
theorem Caused.Holds.change {w w' : World m.signature} (holds : Caused.Holds justified w)
    (recorded : w'.toRecorded = w.toRecorded) (inbox : ∀ e ∈ w'.inbox, e ∈ w.inbox)
    (programs : ∀ f ∈ w'.fibers, f.program.Only (justified w.toRecorded))
    (undos : ∀ f ∈ w'.fibers, ∀ u ∈ f.undo, ∀ failure, justified w.toRecorded (u failure))
    (schedule : ∀ x ∈ w'.schedule, justified w.toRecorded x.2) : Caused.Holds justified w' :=
  ⟨fun e mem => by rw [show w'.log = w.log from congrArg Recorded.log recorded]; exact holds.inbox e (inbox e mem),
    by rw [recorded]; exact programs, by rw [recorded]; exact undos, by rw [recorded]; exact schedule⟩

/-- A fiber's own next step: the rule is kept, and whatever replaces the fiber is justified. -/
theorem Caused.advance (caused : m.Caused rule justified) {w w' : World m.signature}
    {f : Fiber m.signature} {fs : List (Fiber m.signature)} (adv : m.advance w f = some (w', fs))
    (ruled : rule w.toRecorded) (holds : Caused.Holds justified w) (mem : f ∈ w.fibers) :
    rule w'.toRecorded ∧ Caused.Holds justified w' ∧ w'.fibers = w.fibers ∧
      ∀ x ∈ fs, x.program.Only (justified w'.toRecorded) ∧
        ∀ u ∈ x.undo, ∀ failure, justified w'.toRecorded (u failure) := by
  have only := holds.programs f mem
  have undos := holds.undos f mem
  have finished : ∀ status, rule (w.finish f.owner status).toRecorded ∧
      Caused.Holds justified (w.finish f.owner status) ∧ (w.finish f.owner status).fibers = w.fibers := by
    intro status
    unfold World.finish
    cases f.owner with
    | none => exact ⟨ruled, holds, rfl⟩
    | some saga => exact ⟨ruled, holds.change rfl (fun _ h => h) holds.programs holds.undos holds.schedule, rfl⟩
  unfold Model.advance at adv
  split at adv
  · cases adv
    obtain ⟨a, b, c⟩ := finished .completed
    exact ⟨a, b, c, by intro x h; cases h⟩
  · next failure program =>
    split at adv
    · cases adv
      obtain ⟨a, b, c⟩ := finished (.failed failure)
      exact ⟨a, b, c, by intro x h; cases h⟩
    · next u rest undo =>
      cases adv
      have just := undos u (by rw [undo]; exact List.mem_cons_self) failure
      refine ⟨caused.kept _ _ _ just ruled, holds.dispatch caused _, rfl, ?_⟩
      intro x h
      cases List.mem_singleton.mp h
      exact ⟨only.mono fun s' => caused.lasting _ _ _ s', fun u' inRest failure' =>
        caused.lasting _ _ _ _ (undos u' (by rw [undo]; exact List.mem_cons_of_mem _ inRest) failure')⟩
  · next s k program =>
    cases adv
    rw [program] at only
    cases only with
    | send _ _ just rest =>
      refine ⟨caused.kept _ _ _ just ruled, holds.dispatch caused _, rfl, ?_⟩
      intro x h
      cases List.mem_singleton.mp h
      exact ⟨(rest _).mono fun s' => caused.lasting _ _ _ s', fun u inUndo failure =>
        caused.lasting _ _ _ _ (undos u inUndo failure)⟩
  · cases adv
  · next k program =>
    rw [program] at only
    cases only with
    | await _ rest =>
      split at adv
      · cases adv
      · split at adv
        · cases adv
        · cases adv
          refine ⟨ruled, holds.change rfl (fun _ h => h) holds.programs holds.undos holds.schedule,
            rfl, ?_⟩
          intro x h
          cases List.mem_singleton.mp h
          exact ⟨rest _, undos⟩
  · next u k program =>
    cases adv
    rw [program] at only
    cases only with
    | compensate _ _ just rest =>
      refine ⟨ruled, holds, rfl, ?_⟩
      intro x h
      cases List.mem_singleton.mp h
      refine ⟨rest, fun u' inUndo failure => ?_⟩
      rcases List.mem_cons.mp inUndo with rfl | old
      · exact just failure
      · exact undos u' old failure
  · next saga input k program =>
    rw [program] at only
    cases only with
    | start _ _ _ rest =>
      split at adv
      · cases adv
        refine ⟨ruled, holds.change rfl (fun _ h => h) holds.programs holds.undos holds.schedule,
          rfl, ?_⟩
        intro x h
        rcases List.mem_cons.mp h with rfl | h
        · exact ⟨rest, undos⟩
        · cases List.mem_singleton.mp h
          exact ⟨caused.sagas _ saga input, by intro u h; cases h⟩
      · cases adv
        refine ⟨ruled, holds, rfl, ?_⟩
        intro x h
        cases List.mem_singleton.mp h
        exact ⟨rest, undos⟩
  · next saga signal k program =>
    cases adv
    rw [program] at only
    cases only with
    | signal _ _ _ rest =>
      refine ⟨ruled, holds.change rfl (fun _ h => h) holds.programs holds.undos holds.schedule,
        rfl, ?_⟩
      intro x h
      cases List.mem_singleton.mp h
      exact ⟨rest, undos⟩
  · next after s k program =>
    cases adv
    rw [program] at only
    cases only with
    | schedule _ _ _ just rest =>
      refine ⟨ruled, holds.change rfl (fun _ h => h) holds.programs holds.undos ?_, rfl, ?_⟩
      · intro x h
        rcases List.mem_append.mp h with old | new
        · exact holds.schedule x old
        · cases List.mem_singleton.mp new
          exact just
      · intro x h
        cases List.mem_singleton.mp h
        exact ⟨rest, undos⟩

/--
A rule that callers' commands keep, and that justified commands keep, holds in
every world the model can reach, when reactions send only justified commands.
-/
theorem caused (m : Model) {rule : Recorded m.signature.aggregates → Prop}
    {justified : Recorded m.signature.aggregates → Send m.signature.aggregates → Prop}
    (noDecisions : m.decisions = []) (caused : m.Caused rule justified) :
    ∀ w, m.Reachable w → rule w.toRecorded := by
  suffices ∀ w, m.Reachable w → rule w.toRecorded ∧ Caused.Holds justified w from
    fun w reach => (this w reach).1
  intro w reach
  induction reach with
  | start =>
    refine ⟨caused.initially, ⟨?_, ?_, ?_, ?_⟩⟩ <;> intro x h <;> cases h
  | @step w _ _ step ih =>
    obtain ⟨ruled, holds⟩ := ih
    have reacted : ∀ (v : World m.signature) (e : Emitted m.signature.aggregates),
        Caused.Holds justified v → e ∈ v.log → Caused.Holds justified (m.react v e) := by
      intro v e held inLog
      refine held.change rfl (fun _ h => h) ?_ ?_ held.schedule
      · intro f h
        rcases List.mem_append.mp h with old | new
        · exact held.programs f old
        · obtain ⟨p, inPolicies, rfl⟩ := List.mem_map.mp new
          exact caused.policies p inPolicies _ _ e inLog
      · intro f h
        rcases List.mem_append.mp h with old | new
        · exact held.undos f old
        · obtain ⟨p, _, rfl⟩ := List.mem_map.mp new
          intro u h; cases h
    cases step with
    | send s offered => exact ⟨caused.offered _ _ s offered ruled, holds.dispatch caused s⟩
    | decide d actor c mem => rw [noDecisions] at mem; cases mem
    | deliver e before after split =>
      have inLog : e ∈ w.log := holds.inbox e (by rw [split]; simp)
      refine ⟨ruled, reacted { w with inbox := before ++ after } e ?_ inLog⟩
      refine holds.change rfl ?_ holds.programs holds.undos holds.schedule
      intro x h
      rw [split]
      rcases List.mem_append.mp h with l | r
      · exact List.mem_append_left _ l
      · exact List.mem_append_right _ (List.mem_cons_of_mem _ r)
    | redeliver e mem => exact ⟨ruled, reacted w e holds mem⟩
    | advance f before after w' fs split adv =>
      have mem : f ∈ w.fibers := by rw [split]; simp
      obtain ⟨ruled', holds', fibers, replaced⟩ := caused.advance adv ruled holds mem
      have old : ∀ x, x ∈ before ∨ x ∈ after → x ∈ w'.fibers := by
        intro x h
        rw [fibers, split]
        rcases h with l | r
        · exact List.mem_append_left _ l
        · exact List.mem_append_right _ (List.mem_cons_of_mem _ r)
      refine ⟨ruled', holds'.change rfl (fun _ h => h) ?_ ?_ holds'.schedule⟩
      · intro x h
        rcases List.mem_append.mp h with h | r
        · rcases List.mem_append.mp h with l | new
          · exact holds'.programs x (old x (.inl l))
          · exact (replaced x new).1
        · exact holds'.programs x (old x (.inr r))
      · intro x h
        rcases List.mem_append.mp h with h | r
        · rcases List.mem_append.mp h with l | new
          · exact holds'.undos x (old x (.inl l))
          · exact (replaced x new).2
        · exact holds'.undos x (old x (.inr r))
    | answer f before after c k reply split program =>
      have mem : f ∈ w.fibers := by rw [split]; simp
      have only := holds.programs f mem
      rw [program] at only
      cases only with
      | call _ _ rest =>
        have old : ∀ x, x ∈ before ∨ x ∈ after → x ∈ w.fibers := by
          intro x h
          rw [split]
          rcases h with l | r
          · exact List.mem_append_left _ l
          · exact List.mem_append_right _ (List.mem_cons_of_mem _ r)
        refine ⟨ruled, holds.change rfl (fun _ h => h) ?_ ?_ holds.schedule⟩
        · intro x h
          rcases List.mem_append.mp h with l | r
          · exact holds.programs x (old x (.inl l))
          · rcases List.mem_cons.mp r with rfl | r
            · exact rest reply
            · exact holds.programs x (old x (.inr r))
        · intro x h
          rcases List.mem_append.mp h with l | r
          · exact holds.undos x (old x (.inl l))
          · rcases List.mem_cons.mp r with rfl | r
            · exact holds.undos f mem
            · exact holds.undos x (old x (.inr r))
    | tick time later =>
      exact ⟨ruled, holds.change rfl (fun _ h => h) holds.programs holds.undos holds.schedule⟩
    | fire due s before after split isDue =>
      have just : justified w.toRecorded s := holds.schedule (due, s) (by rw [split]; simp)
      have rest : Caused.Holds justified { w with schedule := before ++ after } := by
        refine holds.change rfl (fun _ h => h) holds.programs holds.undos ?_
        intro x h
        refine holds.schedule x ?_
        rw [split]
        rcases List.mem_append.mp h with l | r
        · exact List.mem_append_left _ l
        · exact List.mem_append_right _ (List.mem_cons_of_mem _ r)
      exact ⟨caused.kept _ _ s just ruled, rest.dispatch caused s⟩

/-! ## An event that needs another, across aggregates -/

/-- Every `effect` in these events has its `cause` among them. -/
def Backed {g : Aggregates} (effect : Emitted g → Prop) (cause : Emitted g → Emitted g → Prop)
    (log : List (Emitted g)) : Prop :=
  ∀ e ∈ log, effect e → ∃ c ∈ log, cause e c

/-- A command may be sent: anything it could record that is an `effect` has its `cause` recorded. -/
def Due {g : Aggregates} (effect : Emitted g → Prop) (cause : Emitted g → Emitted g → Prop)
    (log : List (Emitted g)) (s : Send g) : Prop :=
  ∀ x seq time, effect ⟨s.to, (g.of s.to).keyOf s.command, x, seq, time⟩ →
    ∃ c ∈ log, cause ⟨s.to, (g.of s.to).keyOf s.command, x, seq, time⟩ c

/--
"Nothing ships unless it was paid." Callers are offered no command that records
an `effect`, and every policy and saga sends a command that could record one
only when its `cause` is recorded. Then in every world the model can reach,
every `effect` recorded has its `cause` recorded.
-/
theorem backed (m : Model) (noDecisions : m.decisions = [])
    {effect : Emitted m.signature.aggregates → Prop}
    {cause : Emitted m.signature.aggregates → Emitted m.signature.aggregates → Prop}
    (offered : ∀ s, m.offered s → ∀ x seq time,
      ¬effect ⟨s.to, (m.signature.aggregates.of s.to).keyOf s.command, x, seq, time⟩)
    (policies : ∀ p ∈ m.policies, ∀ log history e, e ∈ log →
      (p.react history e).Only (Due effect cause log))
    (sagas : ∀ log saga input, (m.saga saga input).Only (Due effect cause log))
    (w : World m.signature) (reach : m.Reachable w) : Backed effect cause w.log := by
  have step : ∀ (r : Recorded m.signature.aggregates) now s, Due effect cause r.log s →
      Backed effect cause r.log → Backed effect cause (r.dispatch now s).log := by
    intro r now s due backed
    rcases r.dispatch_cases now s with same | ⟨es, _, recorded⟩
    · rw [same]; exact backed
    · rw [recorded]
      obtain ⟨more, grew⟩ := r.log_subset_record now s.to
        ((m.signature.aggregates.of s.to).keyOf s.command) es
      intro e mem isEffect
      rcases Recorded.mem_record_log mem with old | ⟨x, _, seq, rfl⟩
      · obtain ⟨c, inLog, is⟩ := backed e old isEffect
        exact ⟨c, by rw [grew]; exact List.mem_append_left _ inLog, is⟩
      · obtain ⟨c, inLog, is⟩ := due x seq now isEffect
        exact ⟨c, by rw [grew]; exact List.mem_append_left _ inLog, is⟩
  refine m.caused (rule := fun r => Backed effect cause r.log)
    (justified := fun r s => Due effect cause r.log s) noDecisions
    { initially := by intro e h; cases h
      lasting := ?_
      offered := fun r now s isOffered backed =>
        step r now s (fun x seq time isEffect => absurd isEffect (offered s isOffered x seq time)) backed
      kept := fun r now s due backed => step r now s due backed
      policies := fun p mem r history e inLog => policies p mem r.log history e inLog
      sagas := fun r saga input => sagas r.log saga input } w reach
  intro r now s s' due x seq time isEffect
  obtain ⟨more, grew⟩ := r.log_dispatch now s
  obtain ⟨c, inLog, is⟩ := due x seq time isEffect
  exact ⟨c, by rw [grew]; exact List.mem_append_left _ inLog, is⟩

end Model
end Alchemy
