import Alchemy
import Bank.Model
import Bank.Api

/-!
Every cent a transfer takes out of an account is paid into another, paid back,
or recorded as stranded: proved for every world the bank can reach when callers
send what its Apis offer. The proof follows the ExecuteTransfer saga through each
of its steps, so it holds whatever happens between two of them.
-/

open Alchemy

namespace Bank

/-! ## What the saga's steps are, as programs -/

theorem executeTransfer_eq (id : TransferId) (input : ExecuteTransferInput) :
    executeTransfer id input = .compensate (finalizer id) (gate id input) := rfl

theorem gate_waits (id : TransferId) (input : ExecuteTransferInput) (h : input.needsApproval = true) :
    gate id input = .await fun approval =>
      match approval with
      | .expired => .pure ()
      | .approved => debit id input.details := by
  simp only [gate, h]
  show Program.bind _ _ = _
  simp only [Program.awaitSignal, Program.bind]
  congr 1

theorem gate_goes (id : TransferId) (input : ExecuteTransferInput) (h : input.needsApproval = false) :
    gate id input = debit id input.details := by
  simp only [gate, h]
  rfl

theorem debit_eq (id : TransferId) (d : TransferDetails) :
    debit id d = .send (debitSend id d) fun answer =>
      match answer with
      | .ok _ => debited id d
      | .error r => .fail (whyNotDebited r) := by
  show Program.bind _ _ = _
  simp only [Program.step, Program.bind]
  congr 1
  funext answer
  cases answer <;> rfl

theorem debited_eq (id : TransferId) (d : TransferDetails) :
    debited id d = .compensate (refunder id d) (credit id d) := rfl

theorem credit_eq (id : TransferId) (d : TransferDetails) :
    credit id d = .send (creditSend id d) fun answer =>
      match answer with
      | .ok _ => Program.tell (completeSend id)
      | .error _ => .fail .destinationClosed := by
  show Program.bind _ _ = _
  simp only [Program.step, Program.bind]
  congr 1
  funext answer
  cases answer <;> rfl

/-! ## Money taken and given -/

/-- What an event takes out of an account for a transfer. -/
def takenOf : AccountEvent → Nat
  | .transferDebited _ amount _ => amount
  | _ => 0

/-- What an event pays in, pays back, or records as stranded. -/
def givenOf : AccountEvent → Nat
  | .transferCredited _ amount _ | .transferRefunded _ amount _ | .refundStranded _ amount => amount
  | _ => 0

def taken (r : Recorded BankAggregates) : Nat := ((r.eventsOf .account).map takenOf).sum
def given (r : Recorded BankAggregates) : Nat := ((r.eventsOf .account).map givenOf).sum

/-- A command to an account, as a send. -/
abbrev accountSend (actor : Actor) (command : AccountCommand) : Send BankAggregates :=
  ⟨.account, actor, command⟩

/-- What a command to an account adds to the account events. -/
def added (r : Recorded BankAggregates) (now : Time) (actor : Actor) (command : AccountCommand) :
    List AccountEvent :=
  match decideAccount ⟨actor, now⟩ (r.state .account (keyOfAccount command)) command with
  | .ok es => es
  | .error _ => []

theorem account_events (r : Recorded BankAggregates) (now : Time) (actor : Actor)
    (command : AccountCommand) :
    (r.dispatch now (accountSend actor command)).eventsOf .account
      = r.eventsOf .account ++ added r now actor command := by
  have outcome : r.outcome now (accountSend actor command)
      = decideAccount ⟨actor, now⟩ (r.state .account (keyOfAccount command)) command := rfl
  unfold Recorded.dispatch added
  cases h : decideAccount ⟨actor, now⟩ (r.state .account (keyOfAccount command)) command with
  | ok es =>
    rw [outcome, h]
    exact Recorded.eventsOf_record_self r now .account (keyOfAccount command) es
  | error e =>
    rw [outcome, h]
    simp

theorem account_money (r : Recorded BankAggregates) (now : Time) (actor : Actor)
    (command : AccountCommand) :
    taken (r.dispatch now (accountSend actor command))
        = taken r + ((added r now actor command).map takenOf).sum ∧
      given (r.dispatch now (accountSend actor command))
        = given r + ((added r now actor command).map givenOf).sum := by
  simp [taken, given, account_events]

/-- A command that moves no transfer money. -/
def quietCommand : AccountCommand → Prop
  | .debitTransfer _ | .creditTransfer _ | .refundTransfer _ => False
  | _ => True

/-- A send that moves no transfer money: anything but a transfer's debit, credit or refund. -/
def Quiet : Send BankAggregates → Prop
  | ⟨.account, _, command⟩ => quietCommand command
  | _ => True

theorem quiet_events {ctx : Context Actor} {state : AccountState} {command : AccountCommand}
    {es : List AccountEvent} (quiet : quietCommand command)
    (h : decideAccount ctx state command = .ok es) :
    (es.map takenOf).sum = 0 ∧ (es.map givenOf).sum = 0 := by
  cases command <;> simp only [quietCommand] at quiet <;> simp only [decideAccount] at h <;>
    (repeat' split at h) <;> (try cases h) <;> simp [takenOf, givenOf]

theorem quiet_adds_nothing (r : Recorded BankAggregates) (now : Time) (actor : Actor)
    (command : AccountCommand) (quiet : quietCommand command) :
    ((added r now actor command).map takenOf).sum = 0 ∧
      ((added r now actor command).map givenOf).sum = 0 := by
  unfold added
  cases h : decideAccount ⟨actor, now⟩ (r.state .account (keyOfAccount command)) command with
  | ok es => exact quiet_events quiet h
  | error e => simp

/-- A quiet send changes neither total. -/
theorem quiet_money (r : Recorded BankAggregates) (now : Time) (s : Send BankAggregates)
    (quiet : Quiet s) :
    taken (r.dispatch now s) = taken r ∧ given (r.dispatch now s) = given r := by
  obtain ⟨to, actor, command⟩ := s
  cases to with
  | customer => cases command
  | usernameClaim => cases command
  | account =>
    have money := account_money r now actor command
    have nothing := quiet_adds_nothing r now actor command quiet
    exact ⟨by rw [money.1, nothing.1]; rfl, by rw [money.2, nothing.2]; rfl⟩
  | transfer =>
    have same : (r.dispatch now ⟨.transfer, actor, command⟩).eventsOf .account
        = r.eventsOf .account := by
      unfold Recorded.dispatch
      split
      · exact Recorded.eventsOf_record_of_ne r now .transfer .account _ _ (by decide)
      · rfl
    simp [taken, given, same]

theorem added_of_ok {r : Recorded BankAggregates} {now : Time} {actor : Actor}
    {command : AccountCommand} {es : List AccountEvent}
    (h : r.outcome now (accountSend actor command) = .ok es) : added r now actor command = es := by
  have decided : decideAccount ⟨actor, now⟩ (r.state .account (keyOfAccount command)) command
      = .ok es := h
  simp [added, decided]

theorem added_of_error {r : Recorded BankAggregates} {now : Time} {actor : Actor}
    {command : AccountCommand} {e : AccountRejection}
    (h : r.outcome now (accountSend actor command) = .error e) : added r now actor command = [] := by
  have decided : decideAccount ⟨actor, now⟩ (r.state .account (keyOfAccount command)) command
      = .error e := h
  simp [added, decided]

/-- A debit that is accepted takes exactly the amount. -/
theorem debit_events {ctx : Context Actor} {state : AccountState} {c : DebitTransfer}
    {es : List AccountEvent} (h : decideAccount ctx state (.debitTransfer c) = .ok es) :
    (es.map takenOf).sum = c.amount ∧ (es.map givenOf).sum = 0 := by
  simp only [decideAccount] at h
  (repeat' split at h) <;> (try cases h) <;> simp [takenOf, givenOf]

/-- A credit that is accepted gives exactly the amount. -/
theorem credit_events {ctx : Context Actor} {state : AccountState} {c : CreditTransfer}
    {es : List AccountEvent} (h : decideAccount ctx state (.creditTransfer c) = .ok es) :
    (es.map takenOf).sum = 0 ∧ (es.map givenOf).sum = c.amount := by
  simp only [decideAccount] at h
  (repeat' split at h) <;> (try cases h) <;> simp [takenOf, givenOf]

/-- A refund is never rejected, and gives exactly the amount: paid back, or recorded as stranded. -/
theorem refund_events (ctx : Context Actor) (state : AccountState) (c : RefundTransfer) :
    ∃ es, decideAccount ctx state (.refundTransfer c) = .ok es ∧
      (es.map takenOf).sum = 0 ∧ (es.map givenOf).sum = c.amount := by
  cases state <;> simp [decideAccount, takenOf, givenOf]

/-! ## Programs that move no transfer money -/

/-- A policy's reaction: it sends quiet commands, calls outside, starts and signals sagas. -/
inductive Harmless : Program BankSignature Unit → Prop where
  | pure : Harmless (.pure ())
  | send (s k) : Quiet s → (∀ answer, Harmless (k answer)) → Harmless (.send s k)
  | call (c k) : (∀ reply, Harmless (k reply)) → Harmless (.call c k)
  | start (saga input k) : Harmless k → Harmless (.start saga input k)
  | signal (saga signal k) : Harmless k → Harmless (.signal saga signal k)
  | schedule (after s k) : Quiet s → Harmless k → Harmless (.schedule after s k)

theorem Harmless.bind {p : Program BankSignature Unit} {f : Unit → Program BankSignature Unit}
    (hp : Harmless p) (hf : Harmless (f ())) : Harmless (p.bind f) := by
  induction hp with
  | pure => exact hf
  | send s k quiet _ ih => exact .send s _ quiet ih
  | call c k _ ih => exact .call c _ ih
  | start saga input k _ ih => exact .start saga input _ ih
  | signal saga signal k _ ih => exact .signal saga signal _ ih
  | schedule after s k quiet _ ih => exact .schedule after s _ quiet ih

theorem harmless_tell (s : Send BankAggregates) (quiet : Quiet s) : Harmless (Program.tell s) :=
  .send s _ quiet fun _ => .pure

/-- Every policy of the bank reacts harmlessly, to any event after any history. -/
theorem policies_harmless (p : Policy BankSignature) (mem : p ∈ Bank.policies)
    (history : List (Emitted BankAggregates)) (e : Emitted BankAggregates) :
    Harmless (p.react history e) := by
  simp only [Bank, List.mem_cons, List.mem_nil_iff, or_false] at mem
  obtain ⟨source, id, event, seq, time⟩ := e
  rcases mem with rfl | rfl | rfl | rfl | rfl
  · -- MainAccountProvisioning
    cases source <;> simp only [MainAccountProvisioning, Policy.on] <;> (try exact .pure)
    cases event
    exact harmless_tell _ trivial
  · -- TransferExecution
    cases source <;> simp only [TransferExecution, Policy.on] <;> (try exact .pure)
    cases event
    · exact .start _ _ _ .pure
    · exact .signal _ _ _ .pure
    · exact .pure
    · exact .signal _ _ _ .pure
  · -- TransferApprovalDeadline
    cases source <;> simp only [TransferApprovalDeadline, Policy.on] <;> (try exact .pure)
    cases event <;> (try exact .pure)
    rename_i details needsApproval
    cases needsApproval
    · exact .pure
    · exact .schedule _ _ _ trivial .pure
  · -- FraudReview
    simp only [FraudReview, Policy.onView]
    generalize DailyOutflow.emittedBy history _ = emitted
    induction emitted with
    | nil => exact .pure
    | cons x rest ih =>
      refine Harmless.bind ?_ ih
      refine .call _ _ fun score => ?_
      show Harmless (if score.risk > 80 then _ else _)
      split
      · exact harmless_tell _ trivial
      · exact .pure
  · -- SettlementRefund
    cases source <;> simp only [SettlementRefund, Policy.on] <;> (try exact .pure)
    cases event <;> (try exact .pure)
    exact .call _ _ fun _ => .pure

/-! ## The bank as its callers reach it -/

/-- The bank, with callers sending only what its Apis offer. -/
abbrev ServedBank : Model :=
  { Bank with offered := fun s => CustomerApi.accepts s = true ∨ SupportApi.accepts s = true }

/-- The Apis offer no way to debit, credit or refund a transfer directly. -/
theorem offered_quiet (s : Send BankAggregates) (h : ServedBank.offered s) : Quiet s := by
  obtain ⟨to, actor, command⟩ := s
  cases to <;> cases command <;> simp_all [Quiet, quietCommand, CustomerApi, SupportApi]

/-- Two lists that go together, item by item. -/
inductive Each {α β : Type} (R : α → β → Prop) : List α → List β → Prop where
  | nil : Each R [] []
  | cons {a b as bs} : R a b → Each R as bs → Each R (a :: as) (b :: bs)

theorem Each.append {α β : Type} {R : α → β → Prop} {as as' : List α} {bs bs' : List β}
    (h : Each R as bs) (h' : Each R as' bs') : Each R (as ++ as') (bs ++ bs') := by
  induction h with
  | nil => exact h'
  | cons r _ ih => exact .cons r ih

theorem Each.split {α β : Type} {R : α → β → Prop} {before after : List α} {a : α} :
    ∀ {bs : List β}, Each R (before ++ a :: after) bs →
      ∃ bb b ba, bs = bb ++ b :: ba ∧ Each R before bb ∧ R a b ∧ Each R after ba := by
  induction before with
  | nil =>
    intro bs h
    cases h with
    | cons r rest => exact ⟨[], _, _, rfl, .nil, r, rest⟩
  | cons x xs ih =>
    intro bs h
    cases h with
    | cons r rest =>
      obtain ⟨bb, b, ba, eq, hb, hr, ha⟩ := ih rest
      exact ⟨_ :: bb, b, ba, by rw [eq]; rfl, .cons r hb, hr, ha⟩

/-! ## Where the saga stands, and what it owes -/

/-- A step of the ExecuteTransfer saga a run can be at. -/
inductive Stage where
  | begin (id : TransferId) (input : ExecuteTransferInput)
  | gate (id : TransferId) (input : ExecuteTransferInput)
  | debit (id : TransferId) (d : TransferDetails)
  /-- The debit is recorded, and its compensation is not yet registered. -/
  | debited (id : TransferId) (d : TransferDetails)
  | credit (id : TransferId) (d : TransferDetails)
  | completing (id : TransferId) (d : TransferDetails)
  | finished (id : TransferId) (undo : List (TransferFailure → Send BankAggregates))
  /-- The credit was refused: the refund is next. -/
  | refunding (id : TransferId) (d : TransferDetails) (failure : TransferFailure)
  | failing (id : TransferId) (failure : TransferFailure)
  | failed (id : TransferId) (failure : TransferFailure)

/-- The run's fiber at a stage. -/
def Stage.fiber : Stage → Fiber BankSignature
  | .begin id input => ⟨some id, executeTransfer id input, []⟩
  | .gate id input => ⟨some id, Bank.gate id input, [finalizer id]⟩
  | .debit id d => ⟨some id, Bank.debit id d, [finalizer id]⟩
  | .debited id d => ⟨some id, Bank.debited id d, [finalizer id]⟩
  | .credit id d => ⟨some id, Bank.credit id d, [refunder id d, finalizer id]⟩
  | .completing id d => ⟨some id, Program.tell (completeSend id), [refunder id d, finalizer id]⟩
  | .finished id undo => ⟨some id, .pure (), undo⟩
  | .refunding id d failure => ⟨some id, .fail failure, [refunder id d, finalizer id]⟩
  | .failing id failure => ⟨some id, .fail failure, [finalizer id]⟩
  | .failed id failure => ⟨some id, .fail failure, []⟩

/-- What a run at a stage has taken and not yet given back or passed on. -/
def Stage.owed : Stage → Nat
  | .debited _ d | .credit _ d | .refunding _ d _ => d.amount
  | _ => 0

/-- What a fiber owes: a saga's run by its stage, a policy's reaction nothing. -/
inductive Owes : Fiber BankSignature → Nat → Prop where
  | saga (stage : Stage) : Owes stage.fiber stage.owed
  | policy (p : Program BankSignature Unit) : Harmless p → Owes ⟨none, p, []⟩ 0

theorem dispatch_toRecorded (w : World BankSignature) (s : Send BankAggregates) :
    (w.dispatch s).toRecorded = w.toRecorded.dispatch w.now s := rfl

theorem finish_toRecorded (w : World BankSignature) (owner : Option TransferId)
    (status : SagaStatus BankSignature) : (w.finish owner status).toRecorded = w.toRecorded := by
  cases owner <;> rfl

theorem finish_schedule (w : World BankSignature) (owner : Option TransferId)
    (status : SagaStatus BankSignature) : (w.finish owner status).schedule = w.schedule := by
  cases owner <;> rfl

/-- What a quiet send leaves of the two totals, on the world. -/
theorem quiet_world (w : World BankSignature) (s : Send BankAggregates) (quiet : Quiet s) :
    taken (w.dispatch s).toRecorded = taken w.toRecorded ∧
      given (w.dispatch s).toRecorded = given w.toRecorded :=
  quiet_money w.toRecorded w.now s quiet

/-- What the saga's debit does to the two totals: takes the amount, or nothing. -/
theorem debit_world (w : World BankSignature) (id : TransferId) (d : TransferDetails) :
    (∀ es, w.toRecorded.outcome w.now (debitSend id d) = .ok es →
        taken (w.dispatch (debitSend id d)).toRecorded = taken w.toRecorded + d.amount ∧
          given (w.dispatch (debitSend id d)).toRecorded = given w.toRecorded) ∧
      (∀ e, w.toRecorded.outcome w.now (debitSend id d) = .error e →
        taken (w.dispatch (debitSend id d)).toRecorded = taken w.toRecorded ∧
          given (w.dispatch (debitSend id d)).toRecorded = given w.toRecorded) := by
  have money := account_money w.toRecorded w.now sagaActor
    (.debitTransfer ⟨d.source, id, d.amount, d.requestedBy⟩)
  constructor
  · intro es outcome
    have events := debit_events (ctx := ⟨sagaActor, w.now⟩) (state := w.state .account d.source)
      (c := ⟨d.source, id, d.amount, d.requestedBy⟩) (es := es) outcome
    rw [added_of_ok outcome] at money
    exact ⟨by rw [dispatch_toRecorded, money.1, events.1], by rw [dispatch_toRecorded, money.2, events.2]; rfl⟩
  · intro e outcome
    rw [added_of_error outcome] at money
    exact ⟨by rw [dispatch_toRecorded, money.1]; rfl, by rw [dispatch_toRecorded, money.2]; rfl⟩

/-- What the saga's credit does to the two totals: gives the amount, or nothing. -/
theorem credit_world (w : World BankSignature) (id : TransferId) (d : TransferDetails) :
    (∀ es, w.toRecorded.outcome w.now (creditSend id d) = .ok es →
        taken (w.dispatch (creditSend id d)).toRecorded = taken w.toRecorded ∧
          given (w.dispatch (creditSend id d)).toRecorded = given w.toRecorded + d.amount) ∧
      (∀ e, w.toRecorded.outcome w.now (creditSend id d) = .error e →
        taken (w.dispatch (creditSend id d)).toRecorded = taken w.toRecorded ∧
          given (w.dispatch (creditSend id d)).toRecorded = given w.toRecorded) := by
  have money := account_money w.toRecorded w.now sagaActor
    (.creditTransfer ⟨d.destination, id, d.amount⟩)
  constructor
  · intro es outcome
    have events := credit_events (ctx := ⟨sagaActor, w.now⟩)
      (state := w.state .account d.destination) (c := ⟨d.destination, id, d.amount⟩) (es := es) outcome
    rw [added_of_ok outcome] at money
    exact ⟨by rw [dispatch_toRecorded, money.1, events.1]; rfl, by rw [dispatch_toRecorded, money.2, events.2]⟩
  · intro e outcome
    rw [added_of_error outcome] at money
    exact ⟨by rw [dispatch_toRecorded, money.1]; rfl, by rw [dispatch_toRecorded, money.2]; rfl⟩

/-- The refund always gives the amount back: paid in, or recorded as stranded. -/
theorem refund_world (w : World BankSignature) (id : TransferId) (d : TransferDetails)
    (failure : TransferFailure) :
    taken (w.dispatch (refunder id d failure)).toRecorded = taken w.toRecorded ∧
      given (w.dispatch (refunder id d failure)).toRecorded = given w.toRecorded + d.amount := by
  have money := account_money w.toRecorded w.now sagaActor (.refundTransfer ⟨d.source, id, d.amount⟩)
  obtain ⟨es, decided, none, all⟩ := refund_events ⟨sagaActor, w.now⟩ (w.state .account d.source)
    ⟨d.source, id, d.amount⟩
  rw [added_of_ok (r := w.toRecorded) (now := w.now) (actor := sagaActor)
    (command := .refundTransfer ⟨d.source, id, d.amount⟩) decided] at money
  exact ⟨by rw [dispatch_toRecorded, money.1, none]; rfl, by rw [dispatch_toRecorded, money.2, all]⟩

/--
One step of a fiber keeps the books: what it takes and gives matches what it
owes before and after. `os` is what the fibers that replace it owe.
-/
theorem advance_owes {w w' : World BankSignature} {f : Fiber BankSignature}
    {fs : List (Fiber BankSignature)} {o : Nat} (owes : Owes f o)
    (adv : ServedBank.advance w f = some (w', fs)) :
    ∃ os, Each Owes fs os ∧
      taken w'.toRecorded + given w.toRecorded + o
        = taken w.toRecorded + given w'.toRecorded + os.sum ∧
      ∀ x ∈ w'.schedule, x ∈ w.schedule ∨ Quiet x.2 := by
  cases owes with
  | saga stage =>
    cases stage with
    | «begin» id input =>
      simp only [Stage.fiber, Model.advance, executeTransfer_eq] at adv
      cases adv
      exact ⟨[0], .cons (.saga (.gate id input)) .nil, by simp [Stage.owed], fun x h => .inl h⟩
    | gate id input =>
      cases approval : input.needsApproval with
      | false =>
        simp only [Stage.fiber, Model.advance, gate_goes id input approval, debit_eq] at adv
        cases adv
        cases outcome : w.toRecorded.outcome w.now (debitSend id input.details) with
        | ok es =>
          obtain ⟨t, g⟩ := (debit_world w id input.details).1 es outcome
          refine ⟨[input.details.amount], .cons ?_ .nil, ?_, fun x h => .inl h⟩
          · simpa [Stage.fiber, Stage.owed, outcome] using Owes.saga (.debited id input.details)
          · simp only [Stage.owed, List.sum_cons, List.sum_nil]
            omega
        | error e =>
          obtain ⟨t, g⟩ := (debit_world w id input.details).2 e outcome
          refine ⟨[0], .cons ?_ .nil, ?_, fun x h => .inl h⟩
          · simpa [Stage.fiber, Stage.owed, outcome] using Owes.saga (.failing id (whyNotDebited e))
          · simp only [Stage.owed, List.sum_cons, List.sum_nil]
            omega
      | true =>
        simp only [Stage.fiber, Model.advance, gate_waits id input approval] at adv
        split at adv
        · cases adv
        · next signal rest _ =>
          cases adv
          cases signal with
          | approved =>
            exact ⟨[0], .cons (.saga (.debit id input.details)) .nil, by simp [Stage.owed],
              fun x h => .inl h⟩
          | expired =>
            exact ⟨[0], .cons (.saga (.finished id [finalizer id])) .nil, by simp [Stage.owed],
              fun x h => .inl h⟩
    | debit id d =>
      simp only [Stage.fiber, Model.advance, debit_eq] at adv
      cases adv
      cases outcome : w.toRecorded.outcome w.now (debitSend id d) with
      | ok es =>
        obtain ⟨t, g⟩ := (debit_world w id d).1 es outcome
        refine ⟨[d.amount], .cons ?_ .nil, ?_, fun x h => .inl h⟩
        · simpa [Stage.fiber, Stage.owed, outcome] using Owes.saga (.debited id d)
        · simp only [Stage.owed, List.sum_cons, List.sum_nil]
          omega
      | error e =>
        obtain ⟨t, g⟩ := (debit_world w id d).2 e outcome
        refine ⟨[0], .cons ?_ .nil, ?_, fun x h => .inl h⟩
        · simpa [Stage.fiber, Stage.owed, outcome] using Owes.saga (.failing id (whyNotDebited e))
        · simp only [Stage.owed, List.sum_cons, List.sum_nil]
          omega
    | debited id d =>
      simp only [Stage.fiber, Model.advance, debited_eq] at adv
      cases adv
      exact ⟨[d.amount], .cons (.saga (.credit id d)) .nil, by simp [Stage.owed], fun x h => .inl h⟩
    | credit id d =>
      simp only [Stage.fiber, Model.advance, credit_eq] at adv
      cases adv
      cases outcome : w.toRecorded.outcome w.now (creditSend id d) with
      | ok es =>
        obtain ⟨t, g⟩ := (credit_world w id d).1 es outcome
        refine ⟨[0], .cons ?_ .nil, ?_, fun x h => .inl h⟩
        · simpa [Stage.fiber, Stage.owed, outcome] using Owes.saga (.completing id d)
        · simp only [Stage.owed, List.sum_cons, List.sum_nil]
          omega
      | error e =>
        obtain ⟨t, g⟩ := (credit_world w id d).2 e outcome
        refine ⟨[d.amount], .cons ?_ .nil, ?_, fun x h => .inl h⟩
        · simpa [Stage.fiber, Stage.owed, outcome] using
            Owes.saga (.refunding id d .destinationClosed)
        · simp only [Stage.owed, List.sum_cons, List.sum_nil]
          omega
    | completing id d =>
      simp only [Stage.fiber, Model.advance, Program.tell] at adv
      cases adv
      obtain ⟨t, g⟩ := quiet_world w (completeSend id) trivial
      refine ⟨[0], .cons (.saga (.finished id [refunder id d, finalizer id])) .nil, ?_,
        fun x h => .inl h⟩
      simp only [Stage.owed, List.sum_cons, List.sum_nil]
      omega
    | finished id undo =>
      simp only [Stage.fiber, Model.advance] at adv
      cases adv
      refine ⟨[], .nil, ?_, fun x h => .inl (by simpa [finish_schedule] using h)⟩
      simp [Stage.owed, finish_toRecorded]
    | refunding id d failure =>
      simp only [Stage.fiber, Model.advance] at adv
      cases adv
      obtain ⟨t, g⟩ := refund_world w id d failure
      refine ⟨[0], .cons (.saga (.failing id failure)) .nil, ?_, fun x h => .inl h⟩
      simp only [Stage.owed, List.sum_cons, List.sum_nil]
      omega
    | failing id failure =>
      simp only [Stage.fiber, Model.advance] at adv
      cases adv
      obtain ⟨t, g⟩ := quiet_world w (finalizer id failure) trivial
      refine ⟨[0], .cons (.saga (.failed id failure)) .nil, ?_, fun x h => .inl h⟩
      simp only [Stage.owed, List.sum_cons, List.sum_nil]
      omega
    | failed id failure =>
      simp only [Stage.fiber, Model.advance] at adv
      cases adv
      refine ⟨[], .nil, ?_, fun x h => .inl (by simpa [finish_schedule] using h)⟩
      simp [Stage.owed, finish_toRecorded]
  | policy p harmless =>
    cases harmless with
    | pure =>
      simp only [Model.advance] at adv
      cases adv
      exact ⟨[], .nil, by simp [finish_toRecorded], fun x h => .inl (by simpa [finish_schedule] using h)⟩
    | send s k quiet next =>
      simp only [Model.advance] at adv
      cases adv
      obtain ⟨t, g⟩ := quiet_world w s quiet
      refine ⟨[0], .cons (.policy _ (next _)) .nil, ?_, fun x h => .inl h⟩
      simp only [List.sum_cons, List.sum_nil]
      omega
    | call c k next =>
      simp only [Model.advance] at adv
      cases adv
    | start saga input k next =>
      simp only [Model.advance] at adv
      split at adv
      · cases adv
        exact ⟨[0, 0], .cons (.policy _ next) (.cons (.saga (.begin saga input)) .nil), by simp,
          fun x h => .inl h⟩
      · cases adv
        exact ⟨[0], .cons (.policy _ next) .nil, by simp, fun x h => .inl h⟩
    | signal saga signal k next =>
      simp only [Model.advance] at adv
      cases adv
      exact ⟨[0], .cons (.policy _ next) .nil, by simp, fun x h => .inl h⟩
    | schedule after s k quiet next =>
      simp only [Model.advance] at adv
      cases adv
      refine ⟨[0], .cons (.policy _ next) .nil, by simp, fun x h => ?_⟩
      simp only [List.mem_append, List.mem_singleton] at h
      rcases h with h | rfl
      · exact .inl h
      · exact .inr quiet

/-! ## The rule -/

/-- A registration records nothing on an account. -/
theorem registration_money (r : Recorded BankAggregates) (ctx : Context Actor)
    (c : RegisterCustomer) :
    taken (r.decide Registration ctx c) = taken r ∧ given (r.decide Registration ctx c) = given r := by
  have same : (r.decide Registration ctx c).eventsOf .account = r.eventsOf .account := by
    cases eq : decideRegistration ctx r.state c with
    | error _ => simp [Recorded.decide, Registration, eq]
    | ok rs =>
      obtain ⟨_, _, records⟩ := registration_accepted eq
      subst records
      simp only [Recorded.decide, Registration, eq, Recorded.records, List.foldl]
      rw [Recorded.eventsOf_record_of_ne (g := BankAggregates) (n := .usernameClaim)
          (n' := .account) _ _ _ _ (by decide),
        Recorded.eventsOf_record_of_ne (g := BankAggregates) (n := .customer) (n' := .account)
          _ _ _ _ (by decide)]
  simp [taken, given, same]

/-- What the books say: the fibers' debts add up to what was taken and not given. -/
def Balanced (w : World BankSignature) : Prop :=
  (∃ debts : List Nat, Each Owes w.fibers debts ∧
      taken w.toRecorded = (given w.toRecorded) + debts.sum) ∧
    -- Nothing scheduled moves transfer money.
    ∀ x, x ∈ w.schedule → Quiet x.2

/-- The policies' reactions to an event owe nothing. -/
theorem reactions_owe_nothing (history : List (Emitted BankAggregates))
    (e : Emitted BankAggregates) :
    ∀ policies : List (Policy BankSignature), (∀ p ∈ policies, p ∈ Bank.policies) →
      ∃ owed, Each Owes
        (policies.map fun p => ({ owner := none, program := p.react history e, undo := [] } :
          Fiber BankSignature)) owed ∧ owed.sum = 0 := by
  intro policies
  induction policies with
  | nil => intro _; exact ⟨[], .nil, rfl⟩
  | cons p ps ih =>
    intro mem
    obtain ⟨owed, each, zero⟩ := ih fun q h => mem q (List.mem_cons_of_mem _ h)
    exact ⟨0 :: owed, .cons (.policy _ (policies_harmless p (mem p List.mem_cons_self) history e)) each,
      by simp [zero]⟩

theorem react_balanced (w : World BankSignature) (e : Emitted BankAggregates)
    (h : Balanced w) : Balanced (ServedBank.react w e) := by
  obtain ⟨owed, each, books⟩ := h.1
  obtain ⟨more, reactions, zero⟩ := reactions_owe_nothing (w.log.take e.seq) e Bank.policies
    fun _ h => h
  refine ⟨⟨owed ++ more, each.append reactions, ?_⟩, h.2⟩
  rw [List.sum_append, zero]
  exact books

/--
Every cent a transfer takes out of an account is paid into another, paid back,
recorded as stranded, or still owed by a saga's run that is part-way through.
It holds in every world the bank can reach when callers send what the Apis
offer: in any order of delivery, with any event delivered again, whichever
step runs next, whatever the outside systems answer, whenever time passes.
-/
theorem alwaysBalanced (w : World BankSignature) (reach : ServedBank.Reachable w) : Balanced w := by
  refine ServedBank.worldInvariant (rule := Balanced) ?_ ?_ w reach
  · exact ⟨⟨[], .nil, rfl⟩, fun x h => by cases h⟩
  · intro w w' h step
    obtain ⟨owed, each, books⟩ := h.1
    cases step with
    | send s offered =>
      obtain ⟨t, g⟩ := quiet_world w s (offered_quiet s offered)
      exact ⟨⟨owed, each, by omega⟩, h.2⟩
    | decide d actor c mem =>
      simp only [List.mem_singleton] at mem
      subst mem
      obtain ⟨t, g⟩ := registration_money w.toRecorded ⟨actor, w.now⟩ c
      refine ⟨⟨owed, each, ?_⟩, h.2⟩
      show taken (w.toRecorded.decide Registration ⟨actor, w.now⟩ c)
        = given (w.toRecorded.decide Registration ⟨actor, w.now⟩ c) + owed.sum
      exact t.trans (books.trans (congrArg (· + owed.sum) g.symm))
    | deliver e before after _ =>
      exact react_balanced { w with inbox := before ++ after } e ⟨⟨owed, each, books⟩, h.2⟩
    | redeliver e _ => exact react_balanced w e h
    | advance f before after w'' fs fibers adv =>
      rw [fibers] at each
      obtain ⟨ob, o, oa, eq, eb, owes, ea⟩ := each.split
      obtain ⟨os, eachs, money, sched⟩ := advance_owes owes adv
      subst eq
      refine ⟨⟨ob ++ os ++ oa, (eb.append eachs).append ea, ?_⟩, ?_⟩
      · simp only [List.sum_append, List.sum_cons] at books ⊢
        show taken w''.toRecorded = given w''.toRecorded + _
        omega
      · intro x mem
        rcases sched x mem with old | quiet
        · exact h.2 x old
        · exact quiet
    | answer f before after c k reply fibers program =>
      rw [fibers] at each
      obtain ⟨ob, o, oa, eq, eb, owes, ea⟩ := each.split
      subst eq
      have ⟨zero, next⟩ : o = 0 ∧ Owes { f with program := k reply } 0 := by
        cases owes with
        | saga stage =>
          exfalso
          cases stage with
          | gate id input =>
            cases approval : input.needsApproval with
            | false => simp [Stage.fiber, gate_goes id input approval, debit_eq] at program
            | true => simp [Stage.fiber, gate_waits id input approval] at program
          | _ =>
            simp [Stage.fiber, executeTransfer_eq, debit_eq, debited_eq, credit_eq, Program.tell]
              at program
        | policy p harmless =>
          cases harmless with
          | call c' k' following => cases program; exact ⟨rfl, .policy _ (following _)⟩
          | _ => cases program
      subst zero
      exact ⟨⟨ob ++ 0 :: oa, eb.append (.cons next ea), books⟩, h.2⟩
    | tick time _ => exact ⟨⟨owed, each, books⟩, h.2⟩
    | fire due s before after schedule _ =>
      have quiet : Quiet s := h.2 (due, s) (by rw [schedule]; simp)
      obtain ⟨t, g⟩ := quiet_world { w with schedule := before ++ after } s quiet
      refine ⟨⟨owed, each, by
        show taken ({ w with schedule := before ++ after }.dispatch s).toRecorded = _
        have : taken w.toRecorded = given w.toRecorded + owed.sum := books
        simp only [] at t g
        omega⟩, ?_⟩
      intro x mem
      apply h.2
      rw [schedule]
      have here : x ∈ before ++ after := mem
      simp only [List.mem_append, List.mem_cons] at here ⊢
      rcases here with m | m
      · exact .inl m
      · exact .inr (.inr m)

/--
Once nothing is part-way through, the books close: every cent a transfer took
out of an account was paid into another, paid back, or recorded as stranded.
-/
theorem transfersLoseNoMoney (w : World BankSignature) (reach : ServedBank.Reachable w)
    (settled : w.fibers = []) : taken w.toRecorded = given w.toRecorded := by
  obtain ⟨⟨owed, each, books⟩, _⟩ := alwaysBalanced w reach
  rw [settled] at each
  cases each
  simpa using books

end Bank
