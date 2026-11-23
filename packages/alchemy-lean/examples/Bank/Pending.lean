import Alchemy
import Bank.Money

/-!
Every transfer ends, and none is left pending: proved for every world the bank
can reach, whatever its callers send. Once every event is delivered and no
policy or saga is part-way through or waiting, each transfer that was asked for
has completed or has failed.
-/

open Alchemy

namespace Bank

/-! ## Where a transfer has got to -/

/-- Past its request and any approval: pending, or ended. -/
def PastState : TransferState → Prop
  | .pending _ | .completed | .failed _ => True
  | _ => False

def FailedState : TransferState → Prop
  | .failed _ => True
  | _ => False

def EndedState : TransferState → Prop
  | .completed | .failed _ => True
  | _ => False

abbrev PastAt (r : Recorded BankAggregates) (t : TransferId) : Prop := PastState (r.state .transfer t)
abbrev FailedAt (r : Recorded BankAggregates) (t : TransferId) : Prop :=
  FailedState (r.state .transfer t)
abbrev EndedAt (r : Recorded BankAggregates) (t : TransferId) : Prop := EndedState (r.state .transfer t)

theorem FailedState.past {s : TransferState} (h : FailedState s) : PastState s := by
  cases s <;> simp_all [FailedState, PastState]

theorem FailedState.ended {s : TransferState} (h : FailedState s) : EndedState s := by
  cases s <;> simp_all [FailedState, EndedState]

/-! ## What one command does to a transfer -/

/-- A transfer only moves forward. -/
theorem transfer_forward {ctx : Context Actor} {s : TransferState} {c : TransferCommand}
    {es : List TransferEvent} (h : decideTransfer ctx s c = .ok es) :
    (PastState s → PastState (Transfer.apply s es ctx.now)) ∧
      (FailedState s → FailedState (Transfer.apply s es ctx.now)) ∧
      (EndedState s → EndedState (Transfer.apply s es ctx.now)) ∧
      (s ≠ .new → Transfer.apply s es ctx.now ≠ .new) := by
  cases s <;> cases c <;> simp only [decideTransfer] at h <;> (repeat' split at h) <;>
    (try cases h) <;>
    simp_all [Aggregate.apply, evolveTransfer, PastState, FailedState, EndedState]

/-- What the events a command records say about where the transfer is after them. -/
theorem transfer_events {ctx : Context Actor} {s : TransferState} {c : TransferCommand}
    {es : List TransferEvent} (h : decideTransfer ctx s c = .ok es) :
    (∀ d, .transferRequested d false ∈ es → PastState (Transfer.apply s es ctx.now)) ∧
      (∀ d actor, .transferApproved d actor ∈ es → PastState (Transfer.apply s es ctx.now)) ∧
      (∀ reason, .transferFailed reason ∈ es → FailedState (Transfer.apply s es ctx.now)) ∧
      (Transfer.apply s es ctx.now ≠ .new → s ≠ .new ∨ ∃ d n, .transferRequested d n ∈ es) := by
  cases s <;> cases c <;> simp only [decideTransfer] at h <;> (repeat' split at h) <;>
    (try cases h) <;>
    simp_all [Aggregate.apply, evolveTransfer, PastState, FailedState] <;>
    (try (intro small; simp [Nat.not_le.mpr small]))

/-- Completing a transfer that is past its request ends it. -/
theorem complete_ends {ctx : Context Actor} {s : TransferState} (c : CompleteTransfer)
    (past : PastState s) : EndedState (Transfer.step ctx s (.complete c)) := by
  cases s <;> simp_all [Aggregate.step, decideTransfer, Aggregate.apply, evolveTransfer, PastState,
    EndedState]

/-- Failing a transfer that is past its request ends it. -/
theorem fail_ends {ctx : Context Actor} {s : TransferState} (c : FailTransfer)
    (past : PastState s) : EndedState (Transfer.step ctx s (.fail c)) := by
  cases s <;> simp_all [Aggregate.step, decideTransfer, Aggregate.apply, evolveTransfer, PastState,
    EndedState]

/-! ## What the log says about a transfer -/

/-- The entry records a request for this transfer. -/
def isRequest (t : TransferId) (d : TransferDetails) (n : Bool) (e : Emitted BankAggregates) : Prop :=
  ∃ seq time, e = ⟨.transfer, t, .transferRequested d n, seq, time⟩

def isApproved (t : TransferId) (e : Emitted BankAggregates) : Prop :=
  ∃ d actor seq time, e = ⟨.transfer, t, .transferApproved d actor, seq, time⟩

def isFailed (t : TransferId) (e : Emitted BankAggregates) : Prop :=
  ∃ reason seq time, e = ⟨.transfer, t, .transferFailed reason, seq, time⟩

/-- What the log and the transfers' states always say about each other. -/
structure Facts (r : Recorded BankAggregates) : Prop where
  /-- A small transfer is past its request as soon as it is asked for. -/
  requested : ∀ e, e ∈ r.log → ∀ t d, isRequest t d false e → PastAt r t
  approved : ∀ e, e ∈ r.log → ∀ t, isApproved t e → PastAt r t
  failed : ∀ e, e ∈ r.log → ∀ t, isFailed t e → FailedAt r t
  /-- A transfer that is not new was asked for. -/
  known : ∀ t, r.state .transfer t ≠ .new → ∃ e, e ∈ r.log ∧ ∃ d n, isRequest t d n e

/-- A command to a transfer, as a send. -/
abbrev transferSend (actor : Actor) (command : TransferCommand) : Send BankAggregates :=
  ⟨.transfer, actor, command⟩

/-- A command to a transfer changes nothing, or records what the transfer decided. -/
theorem transfer_dispatch (r : Recorded BankAggregates) (now : Time) (actor : Actor)
    (c : TransferCommand) :
    r.dispatch now (transferSend actor c) = r ∨
      ∃ es, decideTransfer ⟨actor, now⟩ (r.state .transfer (Transfer.keyOf c)) c = .ok es ∧
        r.dispatch now (transferSend actor c) = r.record now .transfer (Transfer.keyOf c) es :=
  Recorded.dispatch_cases r now (transferSend actor c)

/-- No command moves a transfer backward, whichever instance it is sent to. -/
theorem dispatch_forward (r : Recorded BankAggregates) (now : Time) (s : Send BankAggregates)
    (t : TransferId) :
    (PastAt r t → PastAt (r.dispatch now s) t) ∧ (FailedAt r t → FailedAt (r.dispatch now s) t) ∧
      (EndedAt r t → EndedAt (r.dispatch now s) t) ∧
      (r.state .transfer t ≠ .new → (r.dispatch now s).state .transfer t ≠ .new) := by
  obtain ⟨to, actor, c⟩ := s
  cases to with
  | customer => cases c
  | usernameClaim => cases c
  | account =>
    have same := Recorded.dispatch_state_of_ne_name r now ⟨.account, actor, c⟩ .transfer t (by simp)
    simp only [PastAt, FailedAt, EndedAt, same]
    exact ⟨id, id, id, id⟩
  | transfer =>
    rcases transfer_dispatch r now actor c with same | ⟨es, decided, recorded⟩
    · simp only [PastAt, FailedAt, EndedAt, transferSend] at same ⊢
      rw [same]
      exact ⟨id, id, id, id⟩
    · simp only [PastAt, FailedAt, EndedAt, transferSend] at recorded ⊢
      rw [recorded]
      by_cases here : Transfer.keyOf c = t
      · subst here
        rw [Recorded.record_state_self]
        exact transfer_forward decided
      · rw [Recorded.record_state_of_ne _ _ _ _ _ _ here]
        exact ⟨id, id, id, id⟩

/-- A log entry of another aggregate says nothing about a transfer. -/
theorem not_transfer_entry {n : BankAggregate} (ne : n ≠ .transfer) {id : (BankAggregates.of n).Id}
    {x : (BankAggregates.of n).Event} {seq : Nat} {time : Time} (t : TransferId) :
    (∀ d k, ¬ isRequest t d k ⟨n, id, x, seq, time⟩) ∧ ¬ isApproved t ⟨n, id, x, seq, time⟩ ∧
      ¬ isFailed t ⟨n, id, x, seq, time⟩ := by
  refine ⟨?_, ?_, ?_⟩
  · rintro d k ⟨_, _, eq⟩; cases eq; exact ne rfl
  · rintro ⟨_, _, _, _, eq⟩; cases eq; exact ne rfl
  · rintro ⟨_, _, _, eq⟩; cases eq; exact ne rfl

/-- Recording on another aggregate keeps what the log says about transfers. -/
theorem facts_record_other {r : Recorded BankAggregates} (h : Facts r) (time : Time)
    (n : BankAggregate) (ne : n ≠ .transfer) (id : (BankAggregates.of n).Id)
    (es : List (BankAggregates.of n).Event) : Facts (r.record time n id es) := by
  have same : ∀ t, (r.record time n id es).state .transfer t = r.state .transfer t :=
    fun t => Recorded.record_state_of_ne_name r time n .transfer id t es ne
  refine ⟨?_, ?_, ?_, ?_⟩
  · intro e mem t d req
    rcases Recorded.mem_record_log mem with old | ⟨x, _, seq, rfl⟩
    · simpa [PastAt, same] using h.requested e old t d req
    · exact absurd req ((not_transfer_entry ne t).1 d false)
  · intro e mem t app
    rcases Recorded.mem_record_log mem with old | ⟨x, _, seq, rfl⟩
    · simpa [PastAt, same] using h.approved e old t app
    · exact absurd app (not_transfer_entry ne t).2.1
  · intro e mem t failed
    rcases Recorded.mem_record_log mem with old | ⟨x, _, seq, rfl⟩
    · simpa [FailedAt, same] using h.failed e old t failed
    · exact absurd failed (not_transfer_entry ne t).2.2
  · intro t notNew
    rw [same] at notNew
    obtain ⟨e, mem, d, n', req⟩ := h.known t notNew
    exact ⟨e, by simp [Recorded.record, mem], d, n', req⟩

/-- Every command keeps what the log says about transfers. -/
theorem facts_dispatch {r : Recorded BankAggregates} (h : Facts r) (now : Time)
    (s : Send BankAggregates) : Facts (r.dispatch now s) := by
  obtain ⟨to, actor, c⟩ := s
  cases to with
  | customer => cases c
  | usernameClaim => cases c
  | account =>
    rcases Recorded.dispatch_cases r now ⟨.account, actor, c⟩ with same | ⟨es, _, recorded⟩
    · rw [same]; exact h
    · rw [recorded]; exact facts_record_other h now .account (by decide) _ es
  | transfer =>
    rcases transfer_dispatch r now actor c with same | ⟨es, decided, recorded⟩
    · simp only [transferSend] at same; rw [same]; exact h
    · simp only [transferSend] at recorded
      rw [recorded]
      have forward : ∀ t, (PastAt r t → PastAt (r.record now .transfer (Transfer.keyOf c) es) t) ∧
          (FailedAt r t → FailedAt (r.record now .transfer (Transfer.keyOf c) es) t) := by
        intro t
        have all := dispatch_forward r now (transferSend actor c) t
        simp only [transferSend, recorded] at all
        exact ⟨all.1, all.2.1⟩
      refine ⟨?_, ?_, ?_, ?_⟩
      · intro e mem t d req
        rcases Recorded.mem_record_log mem with old | ⟨x, xmem, seq, rfl⟩
        · exact (forward t).1 (h.requested e old t d req)
        · obtain ⟨_, _, eq⟩ := req
          cases eq
          show PastState _
          rw [Recorded.record_state_self]
          exact (transfer_events decided).1 d xmem
      · intro e mem t app
        rcases Recorded.mem_record_log mem with old | ⟨x, xmem, seq, rfl⟩
        · exact (forward t).1 (h.approved e old t app)
        · obtain ⟨d, by_, _, _, eq⟩ := app
          cases eq
          show PastState _
          rw [Recorded.record_state_self]
          exact (transfer_events decided).2.1 d by_ xmem
      · intro e mem t failed
        rcases Recorded.mem_record_log mem with old | ⟨x, xmem, seq, rfl⟩
        · exact (forward t).2 (h.failed e old t failed)
        · obtain ⟨reason, _, _, eq⟩ := failed
          cases eq
          show FailedState _
          rw [Recorded.record_state_self]
          exact (transfer_events decided).2.2.1 reason xmem
      · intro t notNew
        by_cases here : Transfer.keyOf c = t
        · subst here
          rw [Recorded.record_state_self] at notNew
          rcases (transfer_events decided).2.2.2 notNew with was | ⟨d, n, xmem⟩
          · obtain ⟨e, mem, d, n, req⟩ := h.known _ was
            exact ⟨e, by simp [Recorded.record, mem], d, n, req⟩
          · obtain ⟨seq, mem⟩ := Recorded.mem_log_of_recorded r now .transfer (Transfer.keyOf c) es xmem
            exact ⟨_, List.mem_of_mem_drop mem, d, n, seq, now, rfl⟩
        · rw [Recorded.record_state_of_ne _ _ _ _ _ _ here] at notNew
          obtain ⟨e, mem, d, n, req⟩ := h.known t notNew
          exact ⟨e, by simp [Recorded.record, mem], d, n, req⟩

/-- A registration keeps what the log says about transfers. -/
theorem facts_decide {r : Recorded BankAggregates} (h : Facts r) (ctx : Context Actor)
    (c : RegisterCustomer) : Facts (r.decide Registration ctx c) := by
  cases eq : decideRegistration ctx r.state c with
  | error _ => simpa [Recorded.decide, Registration, eq] using h
  | ok rs =>
    obtain ⟨_, _, records⟩ := registration_accepted eq
    subst records
    simp only [Recorded.decide, Registration, eq, Recorded.records, List.foldl]
    exact facts_record_other (facts_record_other h _ .customer (by decide) _ _) _ .usernameClaim
      (by decide) _ _

theorem facts_start : Facts (.start BankAggregates) where
  requested := fun _ mem => nomatch mem
  approved := fun _ mem => nomatch mem
  failed := fun _ mem => nomatch mem
  known := fun _ notNew => absurd rfl notNew

/-! ## Policies whose starts and signals the log backs -/

/--
A policy's reaction that starts a small transfer's saga only once the transfer
is past its request, signals an approval only once it is approved, and signals
an expiry only once it has failed.
-/
inductive Sound (r : Recorded BankAggregates) : Program BankSignature Unit → Prop where
  | pure : Sound r (.pure ())
  | send (s k) : (∀ answer, Sound r (k answer)) → Sound r (.send s k)
  | call (c k) : (∀ reply, Sound r (k reply)) → Sound r (.call c k)
  | start (t input k) : (input.needsApproval = false → PastAt r t) → Sound r k →
      Sound r (.start t input k)
  | signal (t sig k) : (sig = .approved → PastAt r t) → (sig = .expired → FailedAt r t) →
      Sound r k → Sound r (.signal t sig k)
  | schedule (after s k) : Sound r k → Sound r (.schedule after s k)

/-- Transfers only move forward from `r` to `r'`. -/
def Forward (r r' : Recorded BankAggregates) : Prop :=
  ∀ t, (PastAt r t → PastAt r' t) ∧ (FailedAt r t → FailedAt r' t) ∧ (EndedAt r t → EndedAt r' t)

theorem Forward.refl (r : Recorded BankAggregates) : Forward r r := fun _ => ⟨id, id, id⟩

theorem forward_dispatch (r : Recorded BankAggregates) (now : Time) (s : Send BankAggregates) :
    Forward r (r.dispatch now s) := fun t =>
  let all := dispatch_forward r now s t
  ⟨all.1, all.2.1, all.2.2.1⟩

theorem Sound.forward {r r' : Recorded BankAggregates} {p : Program BankSignature Unit}
    (forward : Forward r r') (h : Sound r p) : Sound r' p := by
  induction h with
  | pure => exact .pure
  | send s k _ ih => exact .send s k ih
  | call c k _ ih => exact .call c k ih
  | start t input k past _ ih => exact .start t input k (fun eq => (forward t).1 (past eq)) ih
  | signal t sig k past failed _ ih =>
    exact .signal t sig k (fun eq => (forward t).1 (past eq)) (fun eq => (forward t).2.1 (failed eq)) ih
  | schedule after s k _ ih => exact .schedule after s k ih

theorem Sound.bind {r : Recorded BankAggregates} {p : Program BankSignature Unit}
    {f : Unit → Program BankSignature Unit} (hp : Sound r p) (hf : Sound r (f ())) :
    Sound r (p.bind f) := by
  induction hp with
  | pure => exact hf
  | send s k _ ih => exact .send s _ ih
  | call c k _ ih => exact .call c _ ih
  | start t input k past _ ih => exact .start t input _ past ih
  | signal t sig k past failed _ ih => exact .signal t sig _ past failed ih
  | schedule after s k _ ih => exact .schedule after s _ ih

/-- Every policy's reaction to an event in the log is sound. -/
theorem policies_sound {r : Recorded BankAggregates} (facts : Facts r)
    (p : Policy BankSignature) (mem : p ∈ Bank.policies)
    (history : List (Emitted BankAggregates)) (e : Emitted BankAggregates) (logged : e ∈ r.log) :
    Sound r (p.react history e) := by
  simp only [Bank, List.mem_cons, List.mem_nil_iff, or_false] at mem
  obtain ⟨source, id, event, seq, time⟩ := e
  rcases mem with rfl | rfl | rfl | rfl | rfl
  · cases source <;> simp only [MainAccountProvisioning, Policy.on] <;> (try exact .pure)
    cases event
    exact .send _ _ fun _ => .pure
  · cases source <;> simp only [TransferExecution, Policy.on] <;> (try exact .pure)
    cases event with
    | transferRequested details needsApproval =>
      refine .start _ _ _ (fun small => ?_) .pure
      have small' : needsApproval = false := small
      subst small'
      exact facts.requested _ logged id details ⟨seq, time, rfl⟩
    | transferApproved details actor =>
      exact .signal _ _ _ (fun _ => facts.approved _ logged id ⟨details, actor, seq, time, rfl⟩)
        (fun eq => nomatch eq) .pure
    | transferCompleted => exact .pure
    | transferFailed reason =>
      exact .signal _ _ _ (fun eq => nomatch eq)
        (fun _ => facts.failed _ logged id ⟨reason, seq, time, rfl⟩) .pure
  · cases source <;> simp only [TransferApprovalDeadline, Policy.on] <;> (try exact .pure)
    cases event <;> (try exact .pure)
    rename_i details needsApproval
    cases needsApproval
    · exact .pure
    · exact .schedule _ _ _ .pure
  · simp only [FraudReview, Policy.onView]
    generalize DailyOutflow.emittedBy history _ = emitted
    induction emitted with
    | nil => exact .pure
    | cons x rest ih =>
      refine Sound.bind ?_ ih
      refine .call _ _ fun score => ?_
      show Sound r (if score.risk > 80 then _ else _)
      split
      · exact .send _ _ fun _ => .pure
      · exact .pure
  · cases source <;> simp only [SettlementRefund, Policy.on] <;> (try exact .pure)
    cases event <;> (try exact .pure)
    exact .call _ _ fun _ => .pure

/-! ## Where a saga's run may stand -/

def Stage.id : Stage → TransferId
  | .begin id _ | .gate id _ | .debit id _ | .debited id _ | .credit id _ | .completing id _
  | .finished id _ | .refunding id _ _ | .failing id _ | .failed id _ => id

theorem Stage.owner (stage : Stage) : stage.fiber.owner = some stage.id := by
  cases stage <;> rfl

/-- What has to be true of the transfer for a run to stand at a stage. -/
def StageOk (r : Recorded BankAggregates) : Stage → Prop
  | .begin t input | .gate t input => input.needsApproval = false → PastAt r t
  | .debit t _ | .debited t _ | .credit t _ | .completing t _ | .refunding t _ _ | .failing t _ =>
    PastAt r t
  | .finished t _ | .failed t _ => EndedAt r t

theorem StageOk.forward {r r' : Recorded BankAggregates} {stage : Stage} (forward : Forward r r')
    (h : StageOk r stage) : StageOk r' stage := by
  cases stage <;> simp only [StageOk] at h ⊢ <;>
    first
      | exact fun small => (forward _).1 (h small)
      | exact (forward _).1 h
      | exact (forward _).2.2 h

/-- A fiber the bank can have: a saga's run at a stage it may stand at, or a sound reaction. -/
def Good (r : Recorded BankAggregates) (f : Fiber BankSignature) : Prop :=
  (∃ stage, f = stage.fiber ∧ StageOk r stage) ∨ (∃ p, f = ⟨none, p, []⟩ ∧ Sound r p)

theorem Good.forward {r r' : Recorded BankAggregates} {f : Fiber BankSignature}
    (forward : Forward r r') (h : Good r f) : Good r' f := by
  rcases h with ⟨stage, eq, ok⟩ | ⟨p, eq, sound⟩
  · exact .inl ⟨stage, eq, ok.forward forward⟩
  · exact .inr ⟨p, eq, sound.forward forward⟩

/-! ## What always holds of the bank -/

/-- A fiber that is about to start a saga's run, and nothing else. -/
abbrev starter (t : TransferId) (input : ExecuteTransferInput) : Fiber BankSignature :=
  ⟨none, .start t input (.pure ()), []⟩

/-- The log has a request for this transfer. -/
def WasAsked (log : List (Emitted BankAggregates)) (t : TransferId) : Prop :=
  ∃ e, e ∈ log ∧ ∃ d n, isRequest t d n e

structure Tidy (w : World BankSignature) : Prop where
  facts : Facts w.toRecorded
  /-- Every undelivered event is in the log. -/
  inbox : ∀ e, e ∈ w.inbox → e ∈ w.log
  good : ∀ f, f ∈ w.fibers → Good w.toRecorded f
  /-- A signal a run has not taken yet is backed by where its transfer is. -/
  signals : ∀ t, (Approval.approved ∈ w.signals t → PastAt w.toRecorded t) ∧
    (Approval.expired ∈ w.signals t → FailedAt w.toRecorded t)
  /-- A transfer that was asked for has its saga started, or about to be. -/
  coming : ∀ t, WasAsked w.log t →
    WasAsked w.inbox t ∨ (∃ input, starter t input ∈ w.fibers) ∨ w.sagas t ≠ .notStarted
  /-- A run that is running has a fiber. -/
  running : ∀ t, w.sagas t = .running → ∃ stage : Stage, stage.fiber ∈ w.fibers ∧ stage.id = t
  /-- A run that ended left its transfer ended. -/
  ended : ∀ t, (w.sagas t = .completed ∨ ∃ x, w.sagas t = .failed x) → EndedAt w.toRecorded t

/--
Taking on a new record keeps the bank tidy, when the facts hold of it, the
transfers only moved forward, and the log only grew.
-/
theorem tidy_lift {w : World BankSignature} (h : Tidy w) (r : Recorded BankAggregates)
    (facts : Facts r) (forward : Forward w.toRecorded r)
    (grew : ∃ more, r.log = w.log ++ more) : Tidy (w.lift r) := by
  obtain ⟨more, grew⟩ := grew
  have inbox : (w.lift r).inbox = w.inbox ++ more := by simp [World.lift, grew]
  refine ⟨facts, ?_, ?_, ?_, ?_, ?_, ?_⟩
  · intro e mem
    rw [inbox] at mem
    show e ∈ r.log
    rw [grew]
    rcases List.mem_append.mp mem with old | new
    · exact List.mem_append_left _ (h.inbox e old)
    · exact List.mem_append_right _ new
  · intro f mem
    exact (h.good f mem).forward forward
  · intro t
    exact ⟨fun mem => (forward t).1 ((h.signals t).1 mem), fun mem => (forward t).2.1 ((h.signals t).2 mem)⟩
  · intro t asked
    obtain ⟨e, mem, req⟩ := asked
    have mem' : e ∈ w.log ++ more := grew ▸ mem
    rcases List.mem_append.mp mem' with old | new
    · rcases h.coming t ⟨e, old, req⟩ with ⟨e', mem'', req'⟩ | fiber | started
      · exact .inl ⟨e', by rw [inbox]; exact List.mem_append_left _ mem'', req'⟩
      · exact .inr (.inl fiber)
      · exact .inr (.inr started)
    · exact .inl ⟨e, by rw [inbox]; exact List.mem_append_right _ new, req⟩
  · exact h.running
  · intro t done
    exact (forward t).2.2 (h.ended t done)

theorem dispatch_log (r : Recorded BankAggregates) (now : Time) (s : Send BankAggregates) :
    ∃ more, (r.dispatch now s).log = r.log ++ more := by
  rcases Recorded.dispatch_cases r now s with same | ⟨es, _, recorded⟩
  · exact ⟨[], by simp [same]⟩
  · exact ⟨_, by rw [recorded]; rfl⟩

/-- Sending a command keeps the bank tidy. -/
theorem tidy_dispatch {w : World BankSignature} (h : Tidy w) (s : Send BankAggregates) :
    Tidy (w.dispatch s) :=
  tidy_lift h _ (facts_dispatch h.facts w.now s) (forward_dispatch w.toRecorded w.now s)
    (dispatch_log w.toRecorded w.now s)

/-- Recording keeps what was in the log. -/
theorem records_log (r : Recorded BankAggregates) (time : Time) (rs : List (Record BankAggregates)) :
    ∃ more, (r.records time rs).log = r.log ++ more := by
  unfold Recorded.records
  induction rs generalizing r with
  | nil => exact ⟨[], by simp⟩
  | cons x rs ih =>
    obtain ⟨more, eq⟩ := ih (r.record time x.to x.id [x.event])
    exact ⟨_, by rw [List.foldl_cons, eq]; simp only [Recorded.record, List.append_assoc]; rfl⟩

/-- A registration keeps the bank tidy. -/
theorem tidy_decide {w : World BankSignature} (h : Tidy w) (actor : Actor) (c : RegisterCustomer) :
    Tidy (w.decide Registration actor c) := by
  refine tidy_lift h _ (facts_decide h.facts ⟨actor, w.now⟩ c) ?_ ?_
  · intro t
    have same : (w.toRecorded.decide Registration ⟨actor, w.now⟩ c).state .transfer t
        = w.state .transfer t := by
      cases eq : decideRegistration ⟨actor, w.now⟩ w.state c with
      | error _ => simp [Recorded.decide, Registration, eq]
      | ok rs => exact (registration_states w.toRecorded ⟨actor, w.now⟩ c rs eq).2.2.2 t
    simp only [PastAt, FailedAt, EndedAt, same]
    exact ⟨id, id, id⟩
  · cases eq : decideRegistration ⟨actor, w.now⟩ w.state c with
    | error _ => exact ⟨[], by simp [Recorded.decide, Registration, eq]⟩
    | ok rs =>
      obtain ⟨more, grew⟩ := records_log w.toRecorded w.now rs
      exact ⟨more, by simpa [Recorded.decide, Registration, eq] using grew⟩

/-! ## Replacing one fiber -/

theorem stage_not_starter (stage : Stage) (t : TransferId) (input : ExecuteTransferInput) :
    stage.fiber ≠ starter t input := by
  intro eq
  have owner := congrArg Fiber.owner eq
  rw [Stage.owner] at owner
  cases owner

theorem same_run {stage stage' : Stage} (eq : stage.fiber = stage'.fiber) : stage.id = stage'.id := by
  have owner := congrArg Fiber.owner eq
  rw [Stage.owner, Stage.owner] at owner
  exact Option.some.inj owner

theorem mem_swap {α : Type} {before after fs : List α} {f g : α}
    (mem : g ∈ before ++ f :: after) : g = f ∨ g ∈ before ++ fs ++ after := by
  simp only [List.mem_append, List.mem_cons] at mem ⊢
  rcases mem with b | rfl | a
  · exact .inr (.inl (.inl b))
  · exact .inl rfl
  · exact .inr (.inr a)

/--
The bank stays tidy when one fiber is replaced by others, with the record and
the inbox as they were, provided the new fibers, signals and saga statuses keep
each promise the old ones made.
-/
theorem tidy_swap {w w' : World BankSignature} (h : Tidy w)
    {before after fs : List (Fiber BankSignature)} {f : Fiber BankSignature}
    (fibers : w.fibers = before ++ f :: after)
    (record : w'.toRecorded = w.toRecorded) (inbox : w'.inbox = w.inbox)
    (fibers' : w'.fibers = before ++ fs ++ after)
    (good : ∀ g, g ∈ fs → Good w.toRecorded g)
    (signals : ∀ t, (Approval.approved ∈ w'.signals t → PastAt w.toRecorded t) ∧
      (Approval.expired ∈ w'.signals t → FailedAt w.toRecorded t))
    (started : ∀ t input, f = starter t input → w'.sagas t ≠ .notStarted)
    (kept : ∀ t, w.sagas t ≠ .notStarted → w'.sagas t ≠ .notStarted)
    (running : ∀ t, w'.sagas t = .running →
      (∃ stage : Stage, stage.fiber ∈ fs ∧ stage.id = t) ∨
        (w.sagas t = .running ∧ ∀ stage : Stage, f = stage.fiber → stage.id ≠ t))
    (ended : ∀ t, (w'.sagas t = .completed ∨ ∃ x, w'.sagas t = .failed x) →
      EndedAt w.toRecorded t ∨ (w.sagas t = .completed ∨ ∃ x, w.sagas t = .failed x)) :
    Tidy w' := by
  refine ⟨record ▸ h.facts, ?_, ?_, ?_, ?_, ?_, ?_⟩
  · intro e mem
    rw [inbox] at mem
    show e ∈ w'.toRecorded.log
    rw [record]
    exact h.inbox e mem
  · intro g mem
    rw [fibers'] at mem
    rw [record]
    simp only [List.mem_append] at mem
    rcases mem with (b | m) | a
    · exact h.good g (by rw [fibers]; simp [b])
    · exact good g m
    · exact h.good g (by rw [fibers]; simp [a])
  · intro t
    rw [record]
    exact signals t
  · intro t asked
    have asked' : WasAsked w.log t := by
      have : w'.log = w.log := congrArg Recorded.log record
      rw [← this]; exact asked
    rcases h.coming t asked' with inboxed | ⟨input, mem⟩ | begun
    · exact .inl (inbox ▸ inboxed)
    · rw [fibers] at mem
      rcases mem_swap (fs := fs) mem with same | still
      · exact .inr (.inr (started t input same.symm))
      · exact .inr (.inl ⟨input, fibers' ▸ still⟩)
    · exact .inr (.inr (kept t begun))
  · intro t run
    rcases running t run with ⟨stage, mem, id⟩ | ⟨old, other⟩
    · exact ⟨stage, by rw [fibers']; simp [mem], id⟩
    · obtain ⟨stage, mem, id⟩ := h.running t old
      rw [fibers] at mem
      rcases mem_swap (fs := fs) mem with same | still
      · exact absurd id (other stage same.symm)
      · exact ⟨stage, fibers' ▸ still, id⟩
  · intro t done
    rw [record]
    rcases ended t done with now | old
    · exact now
    · exact h.ended t old

/-- A saga's run moves to its next stage. -/
theorem tidy_next {w w' : World BankSignature} (h : Tidy w)
    {before after : List (Fiber BankSignature)} {f : Fiber BankSignature}
    (fibers : w.fibers = before ++ f :: after) (stage stage' : Stage) (at_ : f = stage.fiber)
    (same : stage'.id = stage.id) (ok : StageOk w.toRecorded stage')
    (record : w'.toRecorded = w.toRecorded) (inbox : w'.inbox = w.inbox)
    (fibers' : w'.fibers = before ++ [stage'.fiber] ++ after)
    (sagas : w'.sagas = w.sagas)
    (signals : ∀ t, (Approval.approved ∈ w'.signals t → PastAt w.toRecorded t) ∧
      (Approval.expired ∈ w'.signals t → FailedAt w.toRecorded t)) : Tidy w' := by
  refine tidy_swap h fibers record inbox fibers' ?_ ?_ ?_ ?_ ?_ ?_
  · intro g mem
    simp only [List.mem_singleton] at mem
    exact .inl ⟨stage', mem, ok⟩
  · exact signals
  · intro t input eq
    exact absurd (at_ ▸ eq) (stage_not_starter stage t input)
  · intro t; rw [sagas]; exact id
  · intro t run
    rw [sagas] at run
    by_cases here : stage.id = t
    · exact .inl ⟨stage', by simp, same.trans here⟩
    · exact .inr ⟨run, fun other eq => fun id => here ((same_run (at_ ▸ eq)).trans id)⟩
  · intro t done
    rw [sagas] at done
    exact .inr done

/-! ## Each kind of step -/

/-- Where a transfer is after a command to it. -/
theorem transfer_state_after (r : Recorded BankAggregates) (now : Time) (actor : Actor)
    (c : TransferCommand) :
    (r.dispatch now (transferSend actor c)).state .transfer (Transfer.keyOf c)
      = Transfer.step ⟨actor, now⟩ (r.state .transfer (Transfer.keyOf c)) c := by
  have outcome : r.outcome now (transferSend actor c)
      = decideTransfer ⟨actor, now⟩ (r.state .transfer (Transfer.keyOf c)) c := rfl
  have decide : Transfer.decide ⟨actor, now⟩ (r.state .transfer (Transfer.keyOf c)) c
      = decideTransfer ⟨actor, now⟩ (r.state .transfer (Transfer.keyOf c)) c := rfl
  unfold Recorded.dispatch Aggregate.step
  rw [outcome, decide]
  cases decideTransfer ⟨actor, now⟩ (r.state .transfer (Transfer.keyOf c)) c with
  | ok es => exact Recorded.record_state_self r now .transfer (Transfer.keyOf c) es
  | error e => rfl

/-- The policies' reactions to an event in the log keep the bank tidy. -/
theorem tidy_react {w : World BankSignature} (h : Tidy w) (e : Emitted BankAggregates)
    (logged : e ∈ w.log) : Tidy (Bank.react w e) := by
  refine ⟨h.facts, h.inbox, ?_, h.signals, ?_, ?_, h.ended⟩
  · intro f mem
    simp only [Model.react, List.mem_append, List.mem_map] at mem
    rcases mem with old | ⟨p, pmem, rfl⟩
    · exact h.good f old
    · exact .inr ⟨_, rfl, policies_sound h.facts p pmem _ e logged⟩
  · intro t asked
    rcases h.coming t asked with inboxed | ⟨input, mem⟩ | begun
    · exact .inl inboxed
    · exact .inr (.inl ⟨input, by simp [Model.react, mem]⟩)
    · exact .inr (.inr begun)
  · intro t run
    obtain ⟨stage, mem, id⟩ := h.running t run
    exact ⟨stage, by simp [Model.react, mem], id⟩

/-- What TransferExecution does about a request: it starts the saga's run. -/
theorem execution_starts (history : List (Emitted BankAggregates)) (t : TransferId)
    (d : TransferDetails) (n : Bool) (seq : Nat) (time : Time) :
    ({ owner := none
       program := TransferExecution.react history ⟨.transfer, t, .transferRequested d n, seq, time⟩
       undo := [] } : Fiber BankSignature) = starter t ⟨d, n⟩ := by
  simp [TransferExecution, Policy.on, Program.startSaga, starter]

/-- Delivering an undelivered event keeps the bank tidy. -/
theorem tidy_deliver {w : World BankSignature} (h : Tidy w) (e : Emitted BankAggregates)
    (before after : List (Emitted BankAggregates)) (inbox : w.inbox = before ++ e :: after) :
    Tidy (Bank.react { w with inbox := before ++ after } e) := by
  have logged : e ∈ w.log := h.inbox e (by rw [inbox]; simp)
  refine ⟨h.facts, ?_, ?_, h.signals, ?_, ?_, h.ended⟩
  · intro x mem
    exact h.inbox x (by
      have : x ∈ before ++ after := mem
      rw [inbox]; simp only [List.mem_append, List.mem_cons] at this ⊢
      rcases this with b | a
      · exact .inl b
      · exact .inr (.inr a))
  · intro f mem
    simp only [Model.react, List.mem_append, List.mem_map] at mem
    rcases mem with old | ⟨p, pmem, rfl⟩
    · exact h.good f old
    · exact .inr ⟨_, rfl, policies_sound h.facts p pmem _ e logged⟩
  · intro t asked
    rcases h.coming t asked with ⟨x, mem, d, n, req⟩ | ⟨input, mem⟩ | begun
    · rw [inbox] at mem
      rcases mem_swap (fs := []) mem with same | still
      · subst same
        obtain ⟨seq, time, rfl⟩ := req
        refine .inr (.inl ⟨⟨d, n⟩, ?_⟩)
        simp only [Model.react, List.mem_append, List.mem_map]
        exact .inr ⟨TransferExecution, by simp, execution_starts _ t d n seq time⟩
      · exact .inl ⟨x, (show x ∈ before ++ after from by simpa using still), d, n, req⟩
    · exact .inr (.inl ⟨input, by simp [Model.react, mem]⟩)
    · exact .inr (.inr begun)
  · intro t run
    obtain ⟨stage, mem, id⟩ := h.running t run
    exact ⟨stage, by simp [Model.react, mem], id⟩

/-- A change that touches nothing the invariant reads. -/
theorem tidy_same {w w' : World BankSignature} (h : Tidy w) (record : w'.toRecorded = w.toRecorded)
    (inbox : w'.inbox = w.inbox) (fibers : w'.fibers = w.fibers) (sagas : w'.sagas = w.sagas)
    (signals : w'.signals = w.signals) : Tidy w' := by
  refine ⟨record ▸ h.facts, ?_, ?_, ?_, ?_, ?_, ?_⟩
  · intro e mem; rw [inbox] at mem; show e ∈ w'.toRecorded.log; rw [record]; exact h.inbox e mem
  · intro f mem; rw [fibers] at mem; rw [record]; exact h.good f mem
  · intro t; rw [record, signals]; exact h.signals t
  · intro t asked
    have : w'.log = w.log := congrArg Recorded.log record
    rw [this] at asked
    rw [inbox, fibers, sagas]
    exact h.coming t asked
  · intro t run; rw [sagas] at run; rw [fibers]; exact h.running t run
  · intro t done; rw [sagas] at done; rw [record]; exact h.ended t done

theorem policy_not_stage (p : Program BankSignature Unit) (stage : Stage) :
    ({ owner := none, program := p, undo := [] } : Fiber BankSignature) ≠ stage.fiber := by
  intro eq
  have owner := congrArg Fiber.owner eq
  rw [Stage.owner] at owner
  cases owner

/-- A saga's run moves to its next stage after sending a command. -/
theorem tidy_next_after {w : World BankSignature} (h : Tidy w) (s : Send BankAggregates)
    {before after : List (Fiber BankSignature)} {f : Fiber BankSignature}
    (fibers : w.fibers = before ++ f :: after) (stage stage' : Stage) (at_ : f = stage.fiber)
    (same : stage'.id = stage.id) (ok : StageOk (w.toRecorded.dispatch w.now s) stage') :
    Tidy { w.dispatch s with fibers := before ++ [stage'.fiber] ++ after } :=
  tidy_next (tidy_dispatch h s) (w := w.dispatch s) fibers stage stage' at_ same ok rfl rfl rfl rfl
    (tidy_dispatch h s).signals

/-- A saga's run ends, with its transfer ended. -/
theorem tidy_finish {w : World BankSignature} (h : Tidy w)
    {before after : List (Fiber BankSignature)} {f : Fiber BankSignature}
    (fibers : w.fibers = before ++ f :: after) (stage : Stage) (at_ : f = stage.fiber)
    (ended : EndedAt w.toRecorded stage.id) (status : SagaStatus BankSignature)
    (isEnd : status = .completed ∨ ∃ x, status = .failed x) :
    Tidy { w.finish (some stage.id) status with fibers := before ++ [] ++ after } := by
  have notStart : status ≠ .notStarted := by rcases isEnd with rfl | ⟨x, rfl⟩ <;> simp
  have notRunning : status ≠ .running := by rcases isEnd with rfl | ⟨x, rfl⟩ <;> simp
  refine tidy_swap h fibers rfl rfl rfl ?_ ?_ ?_ ?_ ?_ ?_
  · intro g mem; cases mem
  · exact h.signals
  · intro t input eq
    exact absurd (at_ ▸ eq) (stage_not_starter stage t input)
  · intro t begun
    show update w.sagas stage.id status t ≠ .notStarted
    unfold update
    split
    · exact notStart
    · exact begun
  · intro t run
    have run' : update w.sagas stage.id status t = .running := run
    unfold update at run'
    split at run'
    · exact absurd run' notRunning
    · next ne => exact .inr ⟨run', fun other eq id => ne (id ▸ (same_run (at_ ▸ eq)).symm ▸ rfl)⟩
  · intro t done
    have done' : update w.sagas stage.id status t = .completed ∨
        ∃ x, update w.sagas stage.id status t = .failed x := done
    unfold update at done'
    split at done'
    · next here => exact .inl (here ▸ ended)
    · exact .inr done'

/-- A policy's reaction takes a step that leaves the sagas and signals alone. -/
theorem tidy_policy {w w' : World BankSignature} (h : Tidy w)
    {before after : List (Fiber BankSignature)} {p p' : Program BankSignature Unit}
    (fibers : w.fibers = before ++ ⟨none, p, []⟩ :: after)
    (notStart : ∀ t input, p ≠ .start t input (.pure ()))
    (sound : Sound w.toRecorded p')
    (record : w'.toRecorded = w.toRecorded) (inbox : w'.inbox = w.inbox)
    (fibers' : w'.fibers = before ++ [⟨none, p', []⟩] ++ after)
    (sagas : w'.sagas = w.sagas) (signals : w'.signals = w.signals) : Tidy w' := by
  refine tidy_swap h fibers record inbox fibers' ?_ ?_ ?_ ?_ ?_ ?_
  · intro g mem
    simp only [List.mem_singleton] at mem
    exact .inr ⟨p', mem, sound⟩
  · intro t; rw [signals]; exact h.signals t
  · intro t input eq
    exact absurd (congrArg Fiber.program eq) (notStart t input)
  · intro t; rw [sagas]; exact id
  · intro t run
    rw [sagas] at run
    exact .inr ⟨run, fun stage eq => absurd eq (policy_not_stage p stage)⟩
  · intro t done
    rw [sagas] at done
    exact .inr done

/-- Completing a transfer that is past its request leaves it ended. -/
theorem complete_world (r : Recorded BankAggregates) (now : Time) (id : TransferId)
    (past : PastAt r id) : EndedAt (r.dispatch now (completeSend id)) id := by
  have after := transfer_state_after r now sagaActor (.complete ⟨id⟩)
  show EndedState ((r.dispatch now (completeSend id)).state .transfer id)
  rw [show (r.dispatch now (completeSend id)).state .transfer id = _ from after]
  exact complete_ends ⟨id⟩ past

/-- Recording a failure on a transfer that is past its request leaves it ended. -/
theorem fail_world (r : Recorded BankAggregates) (now : Time) (id : TransferId)
    (failure : TransferFailure) (past : PastAt r id) :
    EndedAt (r.dispatch now (finalizer id failure)) id := by
  have after := transfer_state_after r now sagaActor (.fail ⟨id, reasonOf failure⟩)
  show EndedState ((r.dispatch now (finalizer id failure)).state .transfer id)
  rw [show (r.dispatch now (finalizer id failure)).state .transfer id = _ from after]
  exact fail_ends ⟨id, reasonOf failure⟩ past

/-- One step of any fiber keeps the bank tidy. -/
theorem tidy_advance {w w' : World BankSignature} (h : Tidy w)
    {before after : List (Fiber BankSignature)} {f : Fiber BankSignature}
    {fs : List (Fiber BankSignature)} (fibers : w.fibers = before ++ f :: after)
    (adv : Bank.advance w f = some (w', fs)) :
    Tidy { w' with fibers := before ++ fs ++ after } := by
  have forward := fun s => forward_dispatch w.toRecorded w.now s
  rcases h.good f (by rw [fibers]; simp) with ⟨stage, at_, ok⟩ | ⟨p, at_, sound⟩
  · subst at_
    cases stage with
    | «begin» id input =>
      simp only [Stage.fiber, Model.advance, executeTransfer_eq] at adv
      cases adv
      exact tidy_next h fibers (.begin id input) (.gate id input) rfl rfl ok rfl rfl rfl rfl h.signals
    | gate id input =>
      cases approval : input.needsApproval with
      | false =>
        have past : PastAt w.toRecorded id := ok approval
        simp only [Stage.fiber, Model.advance, gate_goes id input approval, debit_eq] at adv
        cases adv
        cases outcome : w.toRecorded.outcome w.now (debitSend id input.details) with
        | ok es =>
          have := tidy_next_after h (debitSend id input.details) fibers (.gate id input)
            (.debited id input.details) rfl rfl ((forward _ id).1 past)
          simpa [Stage.fiber, outcome] using this
        | error e =>
          have := tidy_next_after h (debitSend id input.details) fibers (.gate id input)
            (.failing id (whyNotDebited e)) rfl rfl ((forward _ id).1 past)
          simpa [Stage.fiber, outcome] using this
      | true =>
        simp only [Stage.fiber, Model.advance, gate_waits id input approval] at adv
        split at adv
        · cases adv
        · next signal rest waiting =>
          cases adv
          have took : ∀ t, ∀ x, x ∈ update w.signals id rest t → x ∈ w.signals t := by
            intro t x mem
            unfold update at mem
            split at mem
            · next here => subst here; rw [waiting]; exact List.mem_cons_of_mem _ mem
            · exact mem
          have head : signal ∈ w.signals id := by rw [waiting]; exact List.mem_cons_self
          have sigs : ∀ t, (Approval.approved ∈ update w.signals id rest t → PastAt w.toRecorded t) ∧
              (Approval.expired ∈ update w.signals id rest t → FailedAt w.toRecorded t) :=
            fun t => ⟨fun mem => (h.signals t).1 (took t _ mem), fun mem => (h.signals t).2 (took t _ mem)⟩
          cases signal with
          | approved =>
            exact tidy_next h fibers (.gate id input) (.debit id input.details) rfl rfl
              ((h.signals id).1 head) rfl rfl rfl rfl sigs
          | expired =>
            exact tidy_next h fibers (.gate id input) (.finished id [finalizer id]) rfl rfl
              ((h.signals id).2 head).ended rfl rfl rfl rfl sigs
    | debit id d =>
      have past : PastAt w.toRecorded id := ok
      simp only [Stage.fiber, Model.advance, debit_eq] at adv
      cases adv
      cases outcome : w.toRecorded.outcome w.now (debitSend id d) with
      | ok es =>
        have := tidy_next_after h (debitSend id d) fibers (.debit id d) (.debited id d) rfl rfl
          ((forward _ id).1 past)
        simpa [Stage.fiber, outcome] using this
      | error e =>
        have := tidy_next_after h (debitSend id d) fibers (.debit id d)
          (.failing id (whyNotDebited e)) rfl rfl ((forward _ id).1 past)
        simpa [Stage.fiber, outcome] using this
    | debited id d =>
      simp only [Stage.fiber, Model.advance, debited_eq] at adv
      cases adv
      exact tidy_next h fibers (.debited id d) (.credit id d) rfl rfl ok rfl rfl rfl rfl h.signals
    | credit id d =>
      have past : PastAt w.toRecorded id := ok
      simp only [Stage.fiber, Model.advance, credit_eq] at adv
      cases adv
      cases outcome : w.toRecorded.outcome w.now (creditSend id d) with
      | ok es =>
        have := tidy_next_after h (creditSend id d) fibers (.credit id d) (.completing id d) rfl rfl
          ((forward _ id).1 past)
        simpa [Stage.fiber, outcome] using this
      | error e =>
        have := tidy_next_after h (creditSend id d) fibers (.credit id d)
          (.refunding id d .destinationClosed) rfl rfl ((forward _ id).1 past)
        simpa [Stage.fiber, outcome] using this
    | completing id d =>
      simp only [Stage.fiber, Model.advance, Program.tell] at adv
      cases adv
      exact tidy_next_after h (completeSend id) fibers (.completing id d)
        (.finished id [refunder id d, finalizer id]) rfl rfl (complete_world _ _ id ok)
    | finished id undo =>
      simp only [Stage.fiber, Model.advance] at adv
      cases adv
      exact tidy_finish h fibers (.finished id undo) rfl ok .completed (.inl rfl)
    | refunding id d failure =>
      simp only [Stage.fiber, Model.advance] at adv
      cases adv
      exact tidy_next_after h (refunder id d failure) fibers (.refunding id d failure)
        (.failing id failure) rfl rfl ((forward _ id).1 ok)
    | failing id failure =>
      simp only [Stage.fiber, Model.advance] at adv
      cases adv
      exact tidy_next_after h (finalizer id failure) fibers (.failing id failure)
        (.failed id failure) rfl rfl (fail_world _ _ id failure ok)
    | failed id failure =>
      simp only [Stage.fiber, Model.advance] at adv
      cases adv
      exact tidy_finish h fibers (.failed id failure) rfl ok (.failed failure) (.inr ⟨failure, rfl⟩)
  · subst at_
    cases sound with
    | pure =>
      simp only [Model.advance] at adv
      cases adv
      refine tidy_swap h fibers rfl rfl rfl (fs := []) ?_ h.signals ?_ (fun _ begun => begun) ?_ (fun _ => .inr)
      · intro g mem; cases mem
      · intro t input eq; cases eq
      · intro t run
        exact .inr ⟨run, fun stage eq => absurd eq (policy_not_stage _ stage)⟩
    | send s k next =>
      simp only [Model.advance] at adv
      cases adv
      exact tidy_policy (tidy_dispatch h s) (w := w.dispatch s) fibers (fun _ _ eq => nomatch eq)
        ((next _).forward (forward s)) rfl rfl rfl rfl rfl
    | call c k next =>
      simp only [Model.advance] at adv
      cases adv
    | start t input k past next =>
      simp only [Model.advance] at adv
      split at adv
      · next fresh =>
        cases adv
        refine tidy_swap h fibers rfl rfl rfl (fs := [_, _]) ?_ h.signals ?_ ?_ ?_ ?_
        · intro g mem
          simp only [List.mem_cons, List.mem_nil_iff, or_false] at mem
          rcases mem with rfl | rfl
          · exact .inr ⟨k, rfl, next⟩
          · exact .inl ⟨.begin t input, rfl, past⟩
        · intro t' input' eq
          cases eq
          show update w.sagas t .running t ≠ .notStarted
          simp [update]
        · intro t' begun
          show update w.sagas t .running t' ≠ .notStarted
          unfold update
          split
          · simp
          · exact begun
        · intro t' run
          by_cases here : t' = t
          · subst here
            exact .inl ⟨.begin t' input, by simp [Stage.fiber], rfl⟩
          · have run' : update w.sagas t .running t' = .running := run
            simp only [update, here, ↓reduceIte] at run'
            exact .inr ⟨run', fun stage eq => absurd eq (policy_not_stage _ stage)⟩
        · intro t' done
          have done' : update w.sagas t .running t' = .completed ∨
              ∃ x, update w.sagas t .running t' = .failed x := done
          unfold update at done'
          split at done'
          · rcases done' with c | ⟨x, c⟩ <;> cases c
          · exact .inr done'
      · next begun =>
        cases adv
        refine tidy_swap h fibers rfl rfl rfl (fs := [_]) ?_ h.signals ?_ (fun _ begun => begun) ?_ (fun _ => .inr)
        · intro g mem
          simp only [List.mem_singleton] at mem
          exact .inr ⟨k, mem, next⟩
        · intro t' input' eq
          cases eq
          intro fresh
          exact begun fresh
        · intro t' run
          exact .inr ⟨run, fun stage eq => absurd eq (policy_not_stage _ stage)⟩
    | signal t sig k past failed next =>
      simp only [Model.advance] at adv
      cases adv
      refine tidy_swap h fibers rfl rfl rfl (fs := [_]) ?_ ?_ ?_ (fun _ begun => begun) ?_ (fun _ => .inr)
      · intro g mem
        simp only [List.mem_singleton] at mem
        exact .inr ⟨k, mem, next⟩
      · intro t'
        have took : ∀ x, x ∈ update w.signals t (w.signals t ++ [sig]) t' →
            x ∈ w.signals t' ∨ (t' = t ∧ x = sig) := by
          intro x mem
          unfold update at mem
          split at mem
          · next here =>
            subst here
            simp only [List.mem_append, List.mem_singleton] at mem
            rcases mem with old | new
            · exact .inl old
            · exact .inr ⟨rfl, new⟩
          · exact .inl mem
        constructor
        · intro mem
          rcases took _ mem with old | ⟨here, eq⟩
          · exact (h.signals t').1 old
          · subst here; exact past eq.symm
        · intro mem
          rcases took _ mem with old | ⟨here, eq⟩
          · exact (h.signals t').2 old
          · subst here; exact failed eq.symm
      · intro t' input' eq; cases eq
      · intro t' run
        exact .inr ⟨run, fun stage eq => absurd eq (policy_not_stage _ stage)⟩
    | schedule after_ s k next =>
      simp only [Model.advance] at adv
      cases adv
      exact tidy_policy h fibers (fun _ _ eq => nomatch eq) next rfl rfl rfl rfl rfl

/-! ## The rule -/

theorem tidy_start : Tidy (World.start BankSignature) where
  facts := facts_start
  inbox := fun _ mem => nomatch mem
  good := fun _ mem => nomatch mem
  signals := fun _ => ⟨(fun mem => nomatch mem), (fun mem => nomatch mem)⟩
  coming := fun _ ⟨_, mem, _⟩ => nomatch mem
  running := fun _ run => nomatch run
  ended := fun _ done => by rcases done with c | ⟨_, c⟩ <;> cases c

/-- The bank is tidy in every world it can reach, whatever its callers send. -/
theorem alwaysTidy (w : World BankSignature) (reach : Bank.Reachable w) : Tidy w := by
  refine Bank.worldInvariant (rule := Tidy) tidy_start ?_ w reach
  intro w w' h step
  cases step with
  | send s _ => exact tidy_dispatch h s
  | decide d actor c mem =>
    simp only [List.mem_singleton] at mem
    subst mem
    exact tidy_decide h actor c
  | deliver e before after inbox => exact tidy_deliver h e before after inbox
  | redeliver e logged => exact tidy_react h e logged
  | advance f before after w'' fs fibers adv => exact tidy_advance h fibers adv
  | answer f before after c k reply fibers program =>
    rcases h.good f (by rw [fibers]; simp) with ⟨stage, at_, _⟩ | ⟨p, at_, sound⟩
    · exfalso
      subst at_
      cases stage with
      | gate id input =>
        cases approval : input.needsApproval with
        | false => simp [Stage.fiber, gate_goes id input approval, debit_eq] at program
        | true => simp [Stage.fiber, gate_waits id input approval] at program
      | _ =>
        simp [Stage.fiber, executeTransfer_eq, debit_eq, debited_eq, credit_eq, Program.tell]
          at program
    · subst at_
      cases sound with
      | call c' k' next =>
        cases program
        exact tidy_policy h fibers (fun _ _ eq => nomatch eq) (next reply) rfl rfl (by simp) rfl rfl
      | _ => cases program
  | tick time _ => exact tidy_same h rfl rfl rfl rfl rfl
  | fire due s before after _ _ =>
    exact tidy_dispatch (tidy_same h (w' := { w with schedule := before ++ after }) rfl rfl rfl rfl rfl) s

/--
Every transfer ends. In every world the bank can reach, whatever its callers
send, in any order of delivery, with any event delivered again, whichever step
runs next, whatever the outside systems answer and whenever time passes: once
every event is delivered and no policy or saga is part-way through or waiting,
each transfer that was asked for has completed or has failed.
-/
theorem everyTransferEnds (w : World BankSignature) (reach : Bank.Reachable w)
    (delivered : w.inbox = []) (idle : w.fibers = []) (t : TransferId)
    (asked : w.state .transfer t ≠ .new) : EndedState (w.state .transfer t) := by
  have tidy := alwaysTidy w reach
  rcases tidy.coming t (tidy.facts.known t asked) with ⟨_, mem, _⟩ | ⟨_, mem⟩ | begun
  · rw [delivered] at mem; cases mem
  · rw [idle] at mem; cases mem
  · cases status : w.sagas t with
    | notStarted => exact absurd status begun
    | running =>
      obtain ⟨stage, mem, _⟩ := tidy.running t status
      rw [idle] at mem
      cases mem
    | completed => exact tidy.ended t (.inl status)
    | failed x => exact tidy.ended t (.inr ⟨x, status⟩)

/-- No transfer is left pending, under the same conditions: it follows from the rule above. -/
theorem noTransferLeftPending (w : World BankSignature) (reach : Bank.Reachable w)
    (delivered : w.inbox = []) (idle : w.fibers = []) (t : TransferId) (d : TransferDetails) :
    w.state .transfer t ≠ .pending d := by
  intro pending
  have ended := everyTransferEnds w reach delivered idle t (by rw [pending]; simp)
  rw [pending] at ended
  exact ended

end Bank
