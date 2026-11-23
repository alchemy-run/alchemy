import Alchemy
import Bank.Views

open Alchemy

namespace Bank

abbrev Step := Program BankSignature

/-- How long a support agent has to approve a large transfer: 24 hours. -/
def approvalWindow : Time := 86400

/-! ## Policies -/

/-- Whenever a customer registers, open their main account. -/
def MainAccountProvisioning : Policy BankSignature :=
  .on "MainAccountProvisioning" .customer fun customerId event =>
    match event with
    | .customerRegistered name _ =>
      Program.tell ⟨.account, .system "MainAccountProvisioning",
        .openAccount ⟨mainAccountId customerId, customerId, name⟩⟩

/--
Starts the ExecuteTransfer saga for every requested transfer, and passes on what
the Transfer decides about a large one: approved, or expired.
-/
def TransferExecution : Policy BankSignature :=
  .on "TransferExecution" .transfer fun transferId event =>
    match event with
    | .transferRequested details needsApproval =>
      Program.startSaga transferId ⟨details, needsApproval⟩
    | .transferApproved .. => Program.signalSaga transferId .approved
    | .transferFailed _ => Program.signalSaga transferId .expired
    | .transferCompleted => pure ()

/--
Whenever a transfer needs approval, expire it if nobody approves it in time. The
Transfer decides the race, so exactly one of approval and expiry wins.
-/
def TransferApprovalDeadline : Policy BankSignature :=
  .on "TransferApprovalDeadline" .transfer fun transferId event =>
    match event with
    | .transferRequested _ true =>
      Program.later approvalWindow
        ⟨.transfer, .system "TransferApprovalDeadline", .expire ⟨transferId⟩⟩
    | _ => pure ()

/-- Whenever an account's daily outflow crosses the threshold, score it and freeze the account if risky. -/
def FraudReview : Policy BankSignature :=
  .onView "FraudReview" DailyOutflow fun accountId exceeded => do
    let score ← Program.request (σ := BankSignature) (BankCall.fraudScore accountId exceeded.total)
    if score.risk > 80 then
      Program.tell ⟨.account, .system "FraudReview",
        .freeze ⟨accountId, s!"fraud risk {score.risk}"⟩⟩

/-- Whenever money settles on a closed account, refund it. -/
def SettlementRefund : Policy BankSignature :=
  .on "SettlementRefund" .account fun _ event =>
    match event with
    | .settlementOnClosedAccount settlementId amount => do
      let _ ← Program.request (σ := BankSignature) (BankCall.refund settlementId amount)
    | _ => pure ()

/-! ## The ExecuteTransfer saga -/

/-- Why a debit was refused, as a failure of the transfer. -/
def whyNotDebited : AccountRejection → TransferFailure
  | .notOpen => .notOpen
  | .notOwner => .notOwner
  | .frozen reason => .frozen reason
  | .insufficientFunds .. => .insufficientFunds
  | _ => .refused

/-- Why a transfer failed, in the words the Transfer records. -/
def reasonOf : TransferFailure → String
  | .notOpen => "source account not open"
  | .notOwner => "not your account"
  | .frozen reason => s!"source frozen: {reason}"
  | .insufficientFunds => "insufficient funds"
  | .destinationClosed => "destination account not open"
  | .refused => "refused"

/-- What the saga acts as. -/
abbrev sagaActor : Actor := .system "ExecuteTransfer"

abbrev debitSend (id : TransferId) (d : TransferDetails) : Send BankAggregates :=
  ⟨.account, sagaActor, .debitTransfer ⟨d.source, id, d.amount, d.requestedBy⟩⟩

abbrev creditSend (id : TransferId) (d : TransferDetails) : Send BankAggregates :=
  ⟨.account, sagaActor, .creditTransfer ⟨d.destination, id, d.amount⟩⟩

abbrev completeSend (id : TransferId) : Send BankAggregates :=
  ⟨.transfer, sagaActor, .complete ⟨id⟩⟩

/-- The compensation for the debit: give the money back. -/
abbrev refunder (id : TransferId) (d : TransferDetails) : TransferFailure → Send BankAggregates :=
  fun _ => ⟨.account, sagaActor, .refundTransfer ⟨d.source, id, d.amount⟩⟩

/-- Records the failure on the Transfer. Registered first, so it runs last. -/
abbrev finalizer (id : TransferId) : TransferFailure → Send BankAggregates :=
  fun failure => ⟨.transfer, sagaActor, .fail ⟨id, reasonOf failure⟩⟩

/-- Credit the destination, then record the outcome. -/
def credit (id : TransferId) (d : TransferDetails) : Step Unit := do
  Program.step (creditSend id d) fun _ => .destinationClosed
  Program.tell (completeSend id)

/-- Once the debit is recorded: from here on, a failure refunds it. -/
def debited (id : TransferId) (d : TransferDetails) : Step Unit := do
  Program.undoWith (refunder id d)
  credit id d

/-- Debit first: if the credit fails, the money is refunded, so it is never created. -/
def debit (id : TransferId) (d : TransferDetails) : Step Unit := do
  Program.step (debitSend id d) whyNotDebited
  debited id d

/-- A large transfer waits for the Transfer to decide: approved, or expired. -/
def gate (id : TransferId) (input : ExecuteTransferInput) : Step Unit := do
  let approval ← if input.needsApproval then Program.awaitSignal else pure .approved
  match approval with
  | .expired => pure ()
  | .approved => debit id input.details

/--
Moves money between two accounts on behalf of the requester: waits for the
Transfer to decide a large transfer, debits the source, credits the destination,
and refunds the debit if the credit fails. The outcome is recorded on the
Transfer either way.
-/
def executeTransfer (transferId : TransferId) (input : ExecuteTransferInput) : Step Unit := do
  Program.undoWith (finalizer transferId)
  gate transferId input

end Bank
