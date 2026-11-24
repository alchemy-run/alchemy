import Alchemy.Stored

/-!
# The stored engine does only what the model can

`Agrees` says a store stands for a world: the same states, the same events
waiting, the same things part-way through, the same time. Each thing the
stored engine does, on lawful services, leaves a store that agrees with the
world the model's own engine would reach. So a store the engine has run on
always stands for a world the model can reach, and every rule proved of the
model holds of what is stored.
-/
namespace Alchemy

variable {σ : Signature}

/-- The events delivered so far: all that were recorded but those still waiting. -/
def World.delivered (w : World σ) : List (Emitted σ.aggregates) :=
  w.log.take (w.log.length - w.inbox.length)

/-- A store stands for a world, with this much part-way through in the request at hand. -/
structure Agrees {reads : ReadSide σ.aggregates} (h : Held σ reads) (P : Process σ) (w : World σ) :
    Prop where
  state : h.state = w.state
  pending : h.pending = w.inbox.map Emitted.unplaced
  process : P = w.process
  now : h.now = w.now
  /-- What is read has taken in every event delivered, in order. -/
  read : h.read = (w.delivered.map Emitted.unplaced).foldl reads.apply reads.initial
  /-- The events waiting are the newest recorded, oldest first. -/
  ordered : w.inbox = w.log.drop (w.log.length - w.inbox.length)

/-- Recording more leaves what was delivered as it was, and the new events wait in order. -/
theorem World.grown {w w' : World σ} {new : List (Emitted σ.aggregates)}
    (ordered : w.inbox = w.log.drop (w.log.length - w.inbox.length))
    (log : w'.log = w.log ++ new) (inbox : w'.inbox = w.inbox ++ new) :
    w'.delivered = w.delivered ∧ w'.inbox = w'.log.drop (w'.log.length - w'.inbox.length) := by
  have le : w.log.length - w.inbox.length ≤ w.log.length := Nat.sub_le _ _
  have same : w'.log.length - w'.inbox.length = w.log.length - w.inbox.length := by
    rw [log, inbox, List.length_append, List.length_append, Nat.add_sub_add_right]
  refine ⟨?_, ?_⟩
  · rw [World.delivered, same, log, List.take_append_of_le_length le]; rfl
  · rw [same, log, List.drop_append_of_le_length le, ← ordered, inbox]

/-- Delivering the oldest waiting event adds it to what was delivered. -/
theorem World.popped {w w' : World σ} {event : Emitted σ.aggregates}
    {rest : List (Emitted σ.aggregates)}
    (ordered : w.inbox = w.log.drop (w.log.length - w.inbox.length))
    (first : w.inbox = event :: rest) (log : w'.log = w.log) (inbox : w'.inbox = rest) :
    w'.delivered = w.delivered ++ [event] ∧
      w'.inbox = w'.log.drop (w'.log.length - w'.inbox.length) := by
  have length : w.inbox.length = rest.length + 1 := by rw [first]; rfl
  have fits : w.inbox.length ≤ w.log.length := by
    have := congrArg List.length ordered
    rw [List.length_drop] at this
    omega
  have next : w'.log.length - w'.inbox.length = (w.log.length - w.inbox.length) + 1 := by
    rw [log, inbox]; omega
  have head : w.log[w.log.length - w.inbox.length]? = some event := by
    rw [← List.head?_drop, ← ordered, first]; rfl
  refine ⟨?_, ?_⟩
  · rw [World.delivered, next, log, List.take_add_one, head]; rfl
  · rw [next, log, ← List.tail_drop, ← ordered, first, inbox]; rfl

/--
Every policy reacts to an event as it is, not to where it sits in the log or
what was recorded before it. A policy on an aggregate's events always does.
-/
def Model.Local (m : Model) : Prop :=
  ∀ p ∈ m.policies, ∀ history e, p.react history e = p.react [] e.unplaced

theorem Policy.on_local (name : String) (n : σ.aggregates.Name)
    (react : (σ.aggregates.of n).Id → (σ.aggregates.of n).Event → Program σ Unit)
    (history : List (Emitted σ.aggregates)) (e : Emitted σ.aggregates) :
    (Policy.on name n react).react history e = (Policy.on name n react).react [] e.unplaced := rfl

namespace Recorded

variable {g : Aggregates}

/-- What recording adds to the log, as a store hands it on. -/
theorem record_new (r : Recorded g) (time : Time) (n : g.Name) (id : (g.of n).Id)
    (es : List (g.of n).Event) :
    ((r.record time n id es).log.drop r.log.length).map Emitted.unplaced
      = es.map fun e => ⟨n, id, e, 0, time⟩ := by
  simp only [record, List.drop_left]
  suffices ∀ k, ((es.zipIdx k).map fun (e, i) => (⟨n, id, e, r.log.length + i, time⟩ : Emitted g)).map
      Emitted.unplaced = es.map fun e => ⟨n, id, e, 0, time⟩ from this 0
  induction es with
  | nil => intro k; rfl
  | cons e es ih => intro k; simp only [List.zipIdx_cons, List.map_cons, ih (k + 1)]; rfl

end Recorded

namespace World

/-- A rejected command leaves the world as it was. -/
theorem dispatch_rejected (w : World σ) (s : Send σ.aggregates)
    {rejection : (σ.aggregates.of s.to).Rejection}
    (h : w.toRecorded.outcome w.now s = .error rejection) : w.dispatch s = w := by
  cases w
  simp_all [World.dispatch, Recorded.dispatch, World.lift]

/-- An accepted command sets its instance's state, and its events wait to be delivered. -/
theorem dispatch_accepted (w : World σ) (s : Send σ.aggregates)
    {events : List (σ.aggregates.of s.to).Event}
    (h : w.toRecorded.outcome w.now s = .ok events) :
    (w.dispatch s).state = w.state.set s.to ((σ.aggregates.of s.to).keyOf s.command)
        ((σ.aggregates.of s.to).apply (w.state s.to ((σ.aggregates.of s.to).keyOf s.command))
          events w.now) ∧
      (w.dispatch s).inbox.map Emitted.unplaced = w.inbox.map Emitted.unplaced ++
        events.map (fun e => ⟨s.to, (σ.aggregates.of s.to).keyOf s.command, e, 0, w.now⟩) ∧
      (w.dispatch s).process = w.process ∧ (w.dispatch s).now = w.now ∧
      ∃ new, (w.dispatch s).log = w.log ++ new ∧ (w.dispatch s).inbox = w.inbox ++ new := by
  obtain ⟨more, grew⟩ := w.toRecorded.log_subset_record w.now s.to
    ((σ.aggregates.of s.to).keyOf s.command) events
  refine ⟨?_, ?_, ?_, ?_, more, ?_, ?_⟩
  · simp [World.dispatch, Recorded.dispatch, h, World.lift, Recorded.record]
  · simp only [World.dispatch, Recorded.dispatch, h, World.lift, List.map_append]
    rw [Recorded.record_new]
  · simp [World.dispatch, Recorded.dispatch, h, World.lift, World.process]
  · simp [World.dispatch, Recorded.dispatch, h, World.lift]
  · simp only [World.dispatch, Recorded.dispatch, h, World.lift]; exact grew
  · simp only [World.dispatch, Recorded.dispatch, h, World.lift]
    rw [grew, List.drop_left]

end World

namespace Engine

variable {μ : Type → Type} [Monad μ] {S : Type} {acts : Acts μ S} {m : Model}
  {reads : ReadSide m.signature.aggregates} {held : S → Held m.signature reads} {sound : S → Prop}
  {e : Engine μ m reads}

/--
Sending a command through the stores answers what the model answers, and
leaves a store that agrees with the world the command leaves.
-/
theorem record_spec (lawful : e.services.Lawful acts held sound)
    (s : Send m.signature.aggregates) {st : S} {P : Process m.signature}
    {w : World m.signature} (ok : sound st) (agrees : Agrees (held st) P w) :
    (acts.eval (e.record s) st).1 = w.toRecorded.outcome w.now s ∧
      Agrees (held (acts.eval (e.record s) st).2) P (w.dispatch s) ∧
      sound (acts.eval (e.record s) st).2 := by
  obtain ⟨nowIs, nowHeld, nowSound⟩ := lawful.clock.now st ok
  obtain ⟨loadIs, loadHeld, loadSound⟩ :=
    lawful.store.load s.to ((m.signature.aggregates.of s.to).keyOf s.command) _ nowSound
  have time : (acts.eval e.services.clock.now st).1 = w.now := nowIs.trans agrees.now
  have loaded : (acts.eval (e.services.store.load s.to
      ((m.signature.aggregates.of s.to).keyOf s.command)) (acts.eval e.services.clock.now st).2).1
      = w.state s.to ((m.signature.aggregates.of s.to).keyOf s.command) := by
    rw [loadIs, nowHeld]; dsimp only; rw [agrees.state]
  simp only [Engine.record, acts.eval_bind]
  rw [time, loaded]
  cases decided : w.toRecorded.outcome w.now s with
  | error rejection =>
    have same : (m.signature.aggregates.of s.to).decide ⟨s.actor, w.now⟩
        (w.state s.to ((m.signature.aggregates.of s.to).keyOf s.command)) s.command
        = .error rejection := decided
    simp only [same, acts.eval_pure]
    rw [w.dispatch_rejected s decided]
    exact ⟨trivial, by rw [loadHeld, nowHeld]; exact agrees, loadSound⟩
  | ok events =>
    have same : (m.signature.aggregates.of s.to).decide ⟨s.actor, w.now⟩
        (w.state s.to ((m.signature.aggregates.of s.to).keyOf s.command)) s.command
        = .ok events := decided
    obtain ⟨commitHeld, commitSound⟩ := lawful.store.commit s.to
      ((m.signature.aggregates.of s.to).keyOf s.command)
      ((m.signature.aggregates.of s.to).apply
        (w.state s.to ((m.signature.aggregates.of s.to).keyOf s.command)) events w.now)
      events w.now _ loadSound
    obtain ⟨state, inbox, process, now, new, log, waiting⟩ := w.dispatch_accepted s decided
    obtain ⟨delivered, ordered⟩ := World.grown agrees.ordered log waiting
    simp only [same, acts.eval_bind, acts.eval_pure]
    refine ⟨trivial, ⟨?_, ?_, ?_, ?_, ?_, ordered⟩, commitSound⟩
    · rw [commitHeld, loadHeld, nowHeld, state]; dsimp only; rw [agrees.state]
    · rw [commitHeld, loadHeld, nowHeld, inbox]; dsimp only; rw [agrees.pending]
    · rw [process]; exact agrees.process
    · rw [commitHeld, loadHeld, nowHeld, now]; exact agrees.now
    · rw [commitHeld, loadHeld, nowHeld, delivered]; exact agrees.read

/-- A change to what is part-way through, with nothing recorded, agrees with the same change to the world. -/
theorem _root_.Alchemy.Agrees.change {reads : ReadSide σ.aggregates} {h : Held σ reads}
    {P P' : Process σ} {w w' : World σ}
    (agrees : Agrees h P w) (recorded : w'.toRecorded = w.toRecorded) (inbox : w'.inbox = w.inbox)
    (now : w'.now = w.now) (process : P' = w'.process) : Agrees h P' w' :=
  ⟨by rw [agrees.state, ← recorded], by rw [agrees.pending, inbox], process, by rw [agrees.now, now],
    by rw [agrees.read, World.delivered, World.delivered, inbox, recorded],
    by rw [inbox, recorded]; exact agrees.ordered⟩

/-- The same store, seen through what it holds: agreeing is about what is held. -/
theorem _root_.Alchemy.Agrees.of_held {reads : ReadSide σ.aggregates} {h h' : Held σ reads}
    {P : Process σ} {w : World σ} (agrees : Agrees h P w) (state : h'.state = h.state)
    (pending : h'.pending = h.pending) (now : h'.now = h.now) (read : h'.read = h.read) :
    Agrees h' P w :=
  ⟨state ▸ agrees.state, pending ▸ agrees.pending, agrees.process, now ▸ agrees.now,
    read ▸ agrees.read, agrees.ordered⟩

/--
A fiber's next step through the stores is its next step in the model: the same
fibers replace it, and the store agrees with the world it leaves.
-/
theorem advance_spec (lawful : e.services.Lawful acts held sound) (f : Fiber m.signature)
    {st : S} {P : Process m.signature} {w : World m.signature} (ok : sound st)
    (agrees : Agrees (held st) P w) :
    sound (acts.eval (e.advance P f) st).2 ∧
      match m.advance w f with
      | none => (acts.eval (e.advance P f) st).1 = none ∧
          Agrees (held (acts.eval (e.advance P f) st).2) P w
      | some (w', fs) => ∃ P', (acts.eval (e.advance P f) st).1 = some (P', fs) ∧
          Agrees (held (acts.eval (e.advance P f) st).2) P' w' := by
  have process := agrees.process
  subst process
  unfold Model.advance Engine.advance
  cases program : f.program with
  | pure a =>
    cases a
    simp only [acts.eval_pure]
    refine ⟨ok, _, rfl, agrees.change ?_ ?_ ?_ ?_⟩ <;> cases f.owner <;> rfl
  | fail failure =>
    cases undo : f.undo with
    | nil =>
      simp only [acts.eval_pure]
      refine ⟨ok, _, rfl, agrees.change ?_ ?_ ?_ ?_⟩ <;> cases f.owner <;> rfl
    | cons u rest =>
      obtain ⟨_, after, stillSound⟩ := record_spec lawful (u failure) ok agrees
      simp only [acts.eval_bind, acts.eval_pure]
      exact ⟨stillSound, _, rfl, after⟩
  | send s k =>
    obtain ⟨answer, after, stillSound⟩ := record_spec lawful s ok agrees
    simp only [acts.eval_bind, acts.eval_pure]
    rw [answer]
    exact ⟨stillSound, _, rfl, after⟩
  | call c k =>
    simp only [acts.eval_pure]
    exact ⟨ok, trivial, agrees⟩
  | await k =>
    simp only [acts.eval_pure]
    cases owner : f.owner with
    | none => exact ⟨ok, rfl, agrees⟩
    | some saga =>
      dsimp only [World.process]
      cases signals : w.signals saga with
      | nil =>
        refine ⟨ok, ?_⟩
        first | exact ⟨rfl, agrees⟩ | exact ⟨trivial, agrees⟩
      | cons signal rest => exact ⟨ok, _, rfl, agrees.change rfl rfl rfl rfl⟩
  | compensate u k =>
    simp only [acts.eval_pure]
    exact ⟨ok, _, rfl, agrees⟩
  | start saga input k =>
    simp only [acts.eval_pure]
    dsimp only [World.process]
    cases status : w.sagas saga <;>
      first
      | exact ⟨ok, _, rfl, agrees.change rfl rfl rfl rfl⟩
      | exact ⟨ok, _, rfl, agrees⟩
  | signal saga signal k =>
    simp only [acts.eval_pure]
    exact ⟨ok, _, rfl, agrees.change rfl rfl rfl rfl⟩
  | schedule after s k =>
    obtain ⟨nowIs, nowHeld, nowSound⟩ := lawful.clock.now st ok
    simp only [acts.eval_bind, acts.eval_pure]
    rw [nowIs]
    dsimp only
    rw [agrees.now]
    refine ⟨nowSound, _, rfl, ?_⟩
    rw [nowHeld]
    exact agrees.change rfl rfl rfl rfl

/-- The first fiber that can go on through the stores is the first that can in the model. -/
theorem tryFibers_spec (lawful : e.services.Lawful acts held sound) :
    ∀ (after before : List (Fiber m.signature)) {st : S} {P : Process m.signature}
      {w : World m.signature}, sound st → Agrees (held st) P w →
      sound (acts.eval (e.tryFibers P before after) st).2 ∧
        match m.tryFibers w before after with
        | none => (acts.eval (e.tryFibers P before after) st).1 = none ∧
            Agrees (held (acts.eval (e.tryFibers P before after) st).2) P w
        | some w' => ∃ P', (acts.eval (e.tryFibers P before after) st).1 = some P' ∧
            Agrees (held (acts.eval (e.tryFibers P before after) st).2) P' w' := by
  intro after
  induction after with
  | nil =>
    intro before st P w ok agrees
    simp only [Engine.tryFibers, Model.tryFibers, acts.eval_pure]
    exact ⟨ok, trivial, agrees⟩
  | cons f after ih =>
    intro before st P w ok agrees
    have spec := advance_spec lawful f ok agrees
    simp only [Engine.tryFibers, Model.tryFibers, acts.eval_bind]
    cases stepped : m.advance w f with
    | none =>
      simp only [stepped] at spec
      obtain ⟨stillSound, nothing, same⟩ := spec
      simp only [nothing]
      exact ih (before ++ [f]) stillSound same
    | some next =>
      obtain ⟨w', fs⟩ := next
      simp only [stepped] at spec
      obtain ⟨stillSound, P', went, after'⟩ := spec
      simp only [went, acts.eval_pure]
      exact ⟨stillSound, _, rfl, after'.change rfl rfl rfl (by rw [after'.process]; rfl)⟩

/-- One step through the stores is the model's own next step. -/
theorem stepOnce_spec (lawful : e.services.Lawful acts held sound) (plain : m.Local)
    {st : S} {P : Process m.signature} {w : World m.signature} (ok : sound st)
    (agrees : Agrees (held st) P w) :
    sound (acts.eval (e.stepOnce P) st).2 ∧
      match m.stepOnce w with
      | none => (acts.eval (e.stepOnce P) st).1 = none ∧
          Agrees (held (acts.eval (e.stepOnce P) st).2) P w
      | some w' => ∃ P', (acts.eval (e.stepOnce P) st).1 = some P' ∧
          Agrees (held (acts.eval (e.stepOnce P) st).2) P' w' := by
  obtain ⟨nextIs, nextHeld, nextSound⟩ := lawful.delivery.next st ok
  simp only [Engine.stepOnce, Model.stepOnce, acts.eval_bind]
  rw [nextIs, agrees.pending]
  cases inbox : w.inbox with
  | nil =>
    have same : Agrees (held (acts.eval e.services.delivery.next st).2) P w := by
      rw [nextHeld]
      exact agrees.of_held rfl (by dsimp only; rw [agrees.pending, inbox]; rfl) rfl rfl
    have fibers : P.fibers = w.fibers := by rw [agrees.process]; rfl
    simp only [List.map_nil, List.head?_nil]
    rw [fibers]
    exact tryFibers_spec lawful w.fibers [] nextSound same
  | cons event rest =>
    obtain ⟨projectHeld, projectSound⟩ := lawful.project event.unplaced _ nextSound
    obtain ⟨delivered, ordered⟩ := World.popped (w' := m.react { w with inbox := rest } event)
      agrees.ordered inbox rfl rfl
    simp only [List.map_cons, List.head?_cons, acts.eval_bind, acts.eval_pure]
    refine ⟨projectSound, _, rfl, ?_, ?_, ?_, ?_, ?_, ordered⟩
    · rw [projectHeld, nextHeld]; exact agrees.state
    · rw [projectHeld, nextHeld]; dsimp only; rw [agrees.pending, inbox]; rfl
    · rw [agrees.process]
      simp only [World.process, Model.react]
      congr 2
      exact List.map_congr_left fun p mem => by rw [plain p mem (w.log.take event.seq) event]
    · rw [projectHeld, nextHeld]; exact agrees.now
    · rw [projectHeld, nextHeld, delivered]
      dsimp only
      rw [agrees.read, List.map_append, List.foldl_append]
      rfl

/-- Settling through the stores is the model's own settling. -/
theorem settle_spec (lawful : e.services.Lawful acts held sound) (plain : m.Local) :
    ∀ (fuel : Nat) {st : S} {P : Process m.signature} {w : World m.signature}, sound st →
      Agrees (held st) P w →
      sound (acts.eval (e.settle fuel P) st).2 ∧
        Agrees (held (acts.eval (e.settle fuel P) st).2) (acts.eval (e.settle fuel P) st).1
          (m.settle fuel w) := by
  intro fuel
  induction fuel with
  | zero =>
    intro st P w ok agrees
    simp only [Engine.settle, Model.settle, acts.eval_pure]
    exact ⟨ok, agrees⟩
  | succ fuel ih =>
    intro st P w ok agrees
    have spec := stepOnce_spec lawful plain ok agrees
    simp only [Engine.settle, Model.settle, acts.eval_bind]
    cases stepped : m.stepOnce w with
    | none =>
      simp only [stepped] at spec
      obtain ⟨stillSound, nothing, same⟩ := spec
      simp only [nothing, acts.eval_pure]
      exact ⟨stillSound, same⟩
    | some w' =>
      simp only [stepped] at spec
      obtain ⟨stillSound, P', went, after⟩ := spec
      simp only [went]
      exact ih stillSound after

/-- Answering the calls the model waits on is steps the model can take. -/
theorem answerCalls_spec (lawful : e.services.Lawful acts held sound) (plain : m.Local) :
    ∀ (calls : Nat) {st : S} {P : Process m.signature} {w : World m.signature}, sound st →
      Agrees (held st) P w →
      ∃ w', m.Runs w w' ∧ sound (acts.eval (e.answerCalls calls P) st).2 ∧
        Agrees (held (acts.eval (e.answerCalls calls P) st).2)
          (acts.eval (e.answerCalls calls P) st).1 w' := by
  intro calls
  induction calls with
  | zero =>
    intro st P w ok agrees
    simp only [Engine.answerCalls, acts.eval_pure]
    exact ⟨w, .refl w, ok, agrees⟩
  | succ calls ih =>
    intro st P w ok agrees
    unfold Engine.answerCalls
    cases waiting : P.waiting with
    | nil =>
      simp only [acts.eval_pure]
      exact ⟨w, .refl w, ok, agrees⟩
    | cons c rest =>
      obtain ⟨callHeld, callSound⟩ := lawful.call c st ok
      simp only [acts.eval_bind]
      have fibers : P.fibers = w.fibers := by rw [agrees.process]; rfl
      cases answered : m.answerGo c (acts.eval (e.services.call c) st).1 P.fibers with
      | none =>
        simp only [acts.eval_pure]
        exact ⟨w, .refl w, callSound, by rw [callHeld]; exact agrees⟩
      | some fibers' =>
        simp only [acts.eval_bind]
        have step : m.Step w { w with fibers := fibers' } :=
          m.answer_step w _ c (acts.eval (e.services.call c) st).1
            (by rw [Model.answer, ← fibers, answered]; rfl)
        have same : Agrees (held (acts.eval (e.services.call c) st).2) { P with fibers := fibers' }
            { w with fibers := fibers' } := by
          rw [callHeld]
          exact agrees.change rfl rfl rfl (by rw [agrees.process]; rfl)
        obtain ⟨settledSound, settled⟩ := settle_spec lawful plain e.fuel callSound same
        obtain ⟨w', runs, endSound, ends⟩ := ih settledSound settled
        exact ⟨w', Model.Runs.trans (Model.Runs.trans (.step (.refl w) step) (m.settle_runs _ _)) runs,
          endSound, ends⟩

/-- Firing what is due through the stores is steps the model can take. -/
theorem fireDue_spec (lawful : e.services.Lawful acts held sound) (plain : m.Local) :
    ∀ (count : Nat) {st : S} {P : Process m.signature} {w : World m.signature}, sound st →
      Agrees (held st) P w →
      ∃ w', m.Runs w w' ∧ sound (acts.eval (e.fireDue count P) st).2 ∧
        Agrees (held (acts.eval (e.fireDue count P) st).2)
          (acts.eval (e.fireDue count P) st).1 w' := by
  intro count
  induction count with
  | zero =>
    intro st P w ok agrees
    simp only [Engine.fireDue, acts.eval_pure]
    exact ⟨w, .refl w, ok, agrees⟩
  | succ count ih =>
    intro st P w ok agrees
    obtain ⟨nowIs, nowHeld, nowSound⟩ := lawful.clock.now st ok
    have same : Agrees (held (acts.eval e.services.clock.now st).2) P w := by
      rw [nowHeld]; exact agrees
    have schedule : P.schedule = w.schedule := by rw [agrees.process]; rfl
    simp only [Engine.fireDue, acts.eval_bind]
    rw [nowIs]
    dsimp only
    rw [agrees.now, schedule]
    cases found : m.nextDue w.now w.schedule with
    | none =>
      simp only [acts.eval_pure]
      exact ⟨w, .refl w, nowSound, same⟩
    | some next =>
      obtain ⟨before, x, after⟩ := next
      obtain ⟨split, due⟩ := m.nextDue_spec w.now _ _ _ _ found
      have taken : Agrees (held (acts.eval e.services.clock.now st).2)
          { P with schedule := before ++ after } { w with schedule := before ++ after } :=
        same.change rfl rfl rfl (by rw [agrees.process]; rfl)
      obtain ⟨_, sent, sentSound⟩ := record_spec lawful x.2 nowSound taken
      have sent' : Agrees _ { P with schedule := before ++ after }
          ({ w with schedule := before ++ after }.dispatch x.2) := sent
      obtain ⟨settledSound, settled⟩ := settle_spec lawful plain e.fuel sentSound sent'
      obtain ⟨w', runs, endSound, ends⟩ := ih settledSound settled
      simp only [acts.eval_bind]
      exact ⟨w', Model.Runs.trans
          (Model.Runs.trans (.step (.refl w) (.fire w x.1 x.2 before after split due))
            (m.settle_runs _ _)) runs,
        endSound, ends⟩

/--
Sending a command through the stores is steps the model can take: the caller
is answered what the model answers, and the store agrees with where the model ends.
-/
theorem send_spec (lawful : e.services.Lawful acts held sound) (plain : m.Local)
    (s : Send m.signature.aggregates) (offered : m.offered s) {st : S} {w : World m.signature}
    (ok : sound st) (agrees : Agrees (held st) (held st).process w) :
    ∃ w', m.Runs w w' ∧ sound (acts.eval (e.send s) st).2 ∧
      Agrees (held (acts.eval (e.send s) st).2) (held (acts.eval (e.send s) st).2).process w' ∧
      (acts.eval (e.send s) st).1 = w.toRecorded.outcome w.now s := by
  obtain ⟨readIs, readHeld, readSound⟩ := lawful.processes.read st ok
  have read : Agrees (held (acts.eval e.services.processes.read st).2)
      (acts.eval e.services.processes.read st).1 w := by rw [readHeld, readIs]; exact agrees
  obtain ⟨answer, sent, sentSound⟩ := record_spec lawful s readSound read
  obtain ⟨settledSound, settled⟩ := settle_spec lawful plain e.fuel sentSound sent
  obtain ⟨w', runs, answeredSound, answered⟩ := answerCalls_spec lawful plain e.calls settledSound settled
  obtain ⟨keptHeld, keptSound⟩ := lawful.processes.keep _ _ answeredSound
  simp only [Engine.send, acts.eval_bind, acts.eval_pure]
  refine ⟨w', Model.Runs.trans (Model.Runs.trans (.step (.refl w) (.send w s offered))
    (m.settle_runs _ _)) runs, keptSound, ?_, answer⟩
  rw [keptHeld]
  exact answered.of_held rfl rfl rfl rfl

/-- Waking through the stores is steps the model can take. -/
theorem wake_spec (lawful : e.services.Lawful acts held sound) (plain : m.Local) {st : S}
    {w : World m.signature} (ok : sound st) (agrees : Agrees (held st) (held st).process w) :
    ∃ w', m.Runs w w' ∧ sound (acts.eval e.wake st).2 ∧
      Agrees (held (acts.eval e.wake st).2) (held (acts.eval e.wake st).2).process w' := by
  obtain ⟨readIs, readHeld, readSound⟩ := lawful.processes.read st ok
  have read : Agrees (held (acts.eval e.services.processes.read st).2)
      (acts.eval e.services.processes.read st).1 w := by rw [readHeld, readIs]; exact agrees
  obtain ⟨w₁, fired, firedSound, firedAgrees⟩ := fireDue_spec lawful plain e.fuel readSound read
  obtain ⟨w', runs, answeredSound, answered⟩ := answerCalls_spec lawful plain e.calls firedSound firedAgrees
  obtain ⟨keptHeld, keptSound⟩ := lawful.processes.keep _ _ answeredSound
  simp only [Engine.wake, acts.eval_bind]
  refine ⟨w', Model.Runs.trans fired runs, keptSound, ?_⟩
  rw [keptHeld]
  exact answered.of_held rfl rfl rfl rfl

end Engine

/-! ## What is stored stands for a world the model can reach -/

namespace Model

variable (m : Model) {reads : ReadSide m.signature.aggregates}

/-- What the stores hold stands for a world the model can reach. -/
def Stands (h : Held m.signature reads) : Prop :=
  ∃ w, m.Reachable w ∧ Agrees h h.process w

/-- Stores with nothing in them stand for the model before anything happened. -/
theorem Stands.start : m.Stands (Held.start m.signature reads) :=
  ⟨World.start m.signature, .start, rfl, rfl, rfl, rfl, rfl, rfl⟩

variable {m}

/-- Time passing leaves the stores standing for a world the model can reach. -/
theorem Stands.tick {h : Held m.signature reads} (stands : m.Stands h) (time : Time) (later : h.now ≤ time) :
    m.Stands { h with now := time } := by
  obtain ⟨w, reach, agrees⟩ := stands
  exact ⟨{ w with now := time }, .step reach (.tick w time (agrees.now ▸ later)),
    agrees.state, agrees.pending, agrees.process, rfl, agrees.read, agrees.ordered⟩

/--
A rule each aggregate keeps holds of every instance the stores hold: of the
state as it is stored, not of a history replayed.
-/
theorem Stands.always {h : Held m.signature reads} (stands : m.Stands h)
    {P : Rule m.signature.aggregates}
    (initially : ∀ n, P n (m.signature.aggregates.of n).initial)
    (kept : ∀ n, (m.signature.aggregates.of n).Keeps (P n))
    (decided : ∀ d ∈ m.decisions, ∀ r (ctx : Context d.Actor) c,
      Holds P r → Holds P (r.decide d ctx c))
    (n : m.signature.aggregates.Name) (id : (m.signature.aggregates.of n).Id) :
    P n (h.state n id) := by
  obtain ⟨w, reach, agrees⟩ := stands
  rw [agrees.state]
  exact m.always initially kept decided w reach n id

/-- A rule one aggregate keeps holds of every instance of it the stores hold. -/
theorem Stands.alwaysAt {h : Held m.signature reads} (stands : m.Stands h) (noDecisions : m.decisions = [])
    (n : m.signature.aggregates.Name) (P : (m.signature.aggregates.of n).State → Prop)
    (initially : P (m.signature.aggregates.of n).initial)
    (kept : (m.signature.aggregates.of n).Keeps P) (id : (m.signature.aggregates.of n).Id) :
    P (h.state n id) := by
  obtain ⟨w, reach, agrees⟩ := stands
  rw [agrees.state]
  exact m.alwaysAt noDecisions n P initially kept w reach id

end Model

namespace Engine

variable {μ : Type → Type} [Monad μ] {S : Type} {acts : Acts μ S} {m : Model}
  {reads : ReadSide m.signature.aggregates} {held : S → Held m.signature reads} {sound : S → Prop}
  {e : Engine μ m reads}

/--
Whatever command is sent, the stores go on standing for a world the model can
reach, and the caller is answered what the aggregate, as stored, decides.
-/
theorem send_stands (lawful : e.services.Lawful acts held sound) (plain : m.Local)
    (s : Send m.signature.aggregates) (offered : m.offered s) {st : S} (ok : sound st)
    (stands : m.Stands (held st)) :
    m.Stands (held (acts.eval (e.send s) st).2) ∧ sound (acts.eval (e.send s) st).2 ∧
      (acts.eval (e.send s) st).1 = (m.signature.aggregates.of s.to).decide ⟨s.actor, (held st).now⟩
        ((held st).state s.to ((m.signature.aggregates.of s.to).keyOf s.command)) s.command := by
  obtain ⟨w, reach, agrees⟩ := stands
  obtain ⟨w', runs, stillSound, after, answer⟩ := send_spec lawful plain s offered ok agrees
  refine ⟨⟨w', runs.reachable reach, after⟩, stillSound, ?_⟩
  rw [answer, agrees.now, agrees.state]
  rfl

/-- Waking leaves the stores standing for a world the model can reach. -/
theorem wake_stands (lawful : e.services.Lawful acts held sound) (plain : m.Local) {st : S}
    (ok : sound st) (stands : m.Stands (held st)) :
    m.Stands (held (acts.eval e.wake st).2) ∧ sound (acts.eval e.wake st).2 := by
  obtain ⟨w, reach, agrees⟩ := stands
  obtain ⟨w', runs, stillSound, after⟩ := wake_spec lawful plain ok agrees
  exact ⟨⟨w', runs.reachable reach, after⟩, stillSound⟩

end Engine

/-! ## Everything a host does -/

namespace Engine

variable {μ : Type → Type} [Monad μ] {S : Type} {m : Model}
  {reads : ReadSide m.signature.aggregates}

/-- From one state of the stores to another, by what a host does with the engine. -/
inductive Runs (e : Engine μ m reads) (acts : Acts μ S) : S → S → Prop where
  | refl (st) : Runs e acts st st
  /-- A caller sends a command the model offers. -/
  | send {st st'} (s : Send m.signature.aggregates) : m.offered s → Runs e acts st st' →
      Runs e acts st (acts.eval (e.send s) st').2
  /-- The host wakes the model. -/
  | wake {st st'} : Runs e acts st st' → Runs e acts st (acts.eval e.wake st').2

variable {acts : Acts μ S} {held : S → Held m.signature reads} {sound : S → Prop}
  {e : Engine μ m reads}

/--
Whatever a host does with the engine, on services that keep their laws, the
stores go on standing for a world the model can reach.
-/
theorem Runs.stands (lawful : e.services.Lawful acts held sound) (plain : m.Local) {st st' : S}
    (runs : e.Runs acts st st') (ok : sound st) (stands : m.Stands (held st)) :
    m.Stands (held st') ∧ sound st' := by
  induction runs with
  | refl => exact ⟨stands, ok⟩
  | send s offered _ ih =>
    obtain ⟨after, stillSound, _⟩ := send_stands lawful plain s offered ih.2 ih.1
    exact ⟨after, stillSound⟩
  | wake _ ih => exact wake_stands lawful plain ih.2 ih.1

end Engine

namespace Model

variable {m : Model} {reads : ReadSide m.signature.aggregates}

/-- What is true of the states of every world the model can reach is true of what is stored. -/
theorem Stands.holds {h : Held m.signature reads} (stands : m.Stands h)
    {Q : States m.signature.aggregates → Prop} (always : ∀ w, m.Reachable w → Q w.state) :
    Q h.state := by
  obtain ⟨w, reach, agrees⟩ := stands
  rw [agrees.state]
  exact always w reach

end Model

/-! ## Stores held in memory -/

namespace InMemory

/-- Code that changes a value held in memory. -/
def acts (S : Type) : Acts (StateM S) S where
  eval x s := x.run s
  eval_pure _ _ := rfl
  eval_bind _ _ _ := rfl

/-- Every service, on one value in memory. Outside systems answer as `call` says. -/
def services (σ : Signature) (reads : ReadSide σ.aggregates) (call : (c : σ.Call) → σ.Reply c) :
    Services (StateM (Held σ reads)) σ reads where
  store :=
    { load := fun n id => return (← get).state n id
      commit := fun n id state events time => modify fun h =>
        { h with
          state := h.state.set n id state
          pending := h.pending ++ events.map fun e => ⟨n, id, e, 0, time⟩ } }
  delivery :=
    { next := modifyGet fun h => (h.pending.head?, { h with pending := h.pending.tail }) }
  processes :=
    { read := return (← get).process
      keep := fun P => modify fun h => { h with process := P } }
  clock := { now := return (← get).now }
  call := fun c => pure (call c)
  project := fun e => modify fun h => { h with read := reads.apply h.read e }
  look := return (← get).read

/-- They keep every law. -/
theorem lawful (σ : Signature) (reads : ReadSide σ.aggregates) (call : (c : σ.Call) → σ.Reply c) :
    (services σ reads call).Lawful (acts (Held σ reads)) id (fun _ => True) where
  store :=
    { load := fun _ _ _ _ => ⟨rfl, rfl, trivial⟩
      commit := fun _ _ _ _ _ _ _ => ⟨rfl, trivial⟩ }
  delivery := { next := fun _ _ => ⟨rfl, rfl, trivial⟩ }
  processes :=
    { read := fun _ _ => ⟨rfl, rfl, trivial⟩
      keep := fun _ _ _ => ⟨rfl, trivial⟩ }
  clock := { now := fun _ _ => ⟨rfl, rfl, trivial⟩ }
  call := fun _ _ _ => ⟨rfl, trivial⟩
  project := fun _ _ _ => ⟨rfl, trivial⟩
  look := fun _ _ => ⟨rfl, rfl, trivial⟩

end InMemory

end Alchemy
