import Alchemy
import Bank.Model

open Alchemy

namespace Bank

/-! Stories: examples of what the bank does. The compiler runs each one. -/

abbrev Story := List (Story.ModelStep Bank)

def sam : Actor := .customer "c-1"
def alex : Actor := .customer "c-2"
def support : Actor := .agent "support-7"

def opened (customerId : CustomerId := "c-1") : AccountEvent := .accountOpened customerId "Sam"

def registering : Story := [
  .decide Registration sam ⟨"c-1", "Sam", "sam"⟩,
  .recorded .customer "c-1" [.customerRegistered "Sam" "sam"],
  .recorded .usernameClaim "sam" [.usernameClaimed "c-1"],
  .recorded .account "c-1-main" [.accountOpened "c-1" "Sam"],
  .view CustomerDashboard "c-1" { name := some "Sam", balances := [("c-1-main", 0)] } ]

def aTakenUsername : Story := [
  .given .usernameClaim "sam" [.usernameClaimed "c-9"],
  .decide Registration sam ⟨"c-1", "Sam", "sam"⟩ (some .usernameTaken),
  .state .customer "c-1" .new ]

def registeringSomeoneElse : Story := [
  .decide Registration alex ⟨"c-1", "Sam", "sam"⟩ (some .notTheCustomer) ]

def withdrawing : Story := [
  .given .account "a-1" [opened, .moneyDeposited 100 100],
  .replies ⟨.account, sam, .withdraw ⟨"a-1", 30⟩⟩ (some 70),
  .when ⟨.account, sam, .withdraw ⟨"a-1", 30⟩⟩,
  .recorded .account "a-1" [.moneyWithdrawn 30 70],
  .view AccountSummary "a-1"
    { customerId := some "c-1", owner := some "Sam", balance := 70 },
  .emitted Statement "a-1" [⟨.deposit, 100, 100⟩, ⟨.withdrawal, 30, 70⟩] ]

def anOverdraft : Story := [
  .given .account "a-1" [opened, .moneyDeposited 50 50],
  .when ⟨.account, sam, .withdraw ⟨"a-1", 80⟩⟩,
  .rejected .account (.insufficientFunds 50 80) ]

def someoneElsesAccount : Story := [
  .given .account "a-1" [opened, .moneyDeposited 100 100],
  .when ⟨.account, alex, .withdraw ⟨"a-1", 30⟩⟩,
  .rejected .account .notOwner ]

def theDailyLimit : Story := [
  .given .account "a-1" [opened, .moneyDeposited 300000 300000],
  .when ⟨.account, sam, .withdraw ⟨"a-1", 40000⟩⟩,
  .when ⟨.account, sam, .withdraw ⟨"a-1", 40000⟩⟩,
  .call (.fraudScore "a-1" 80000),
  .answer (.fraudScore "a-1" 80000) ⟨10⟩,
  .when ⟨.account, sam, .withdraw ⟨"a-1", 30000⟩⟩,
  .rejected .account (.dailyLimitExceeded 20000),
  .pass 86400,
  .when ⟨.account, sam, .withdraw ⟨"a-1", 30000⟩⟩,
  .recorded .account "a-1"
    [.moneyWithdrawn 40000 260000, .moneyWithdrawn 40000 220000, .moneyWithdrawn 30000 190000] ]

def freezingTwice : Story := [
  .given .account "a-1" [opened, .accountFrozen "kyc" support],
  .when ⟨.account, support, .freeze ⟨"a-1", "again"⟩⟩,
  .recorded .account "a-1" [],
  .holds "still frozen for the first reason" fun w =>
    match w.state .account "a-1" with
    | .opened account => account.frozen = some "kyc"
    | _ => false ]

def aRiskyWithdrawal : Story := [
  .given .account "a-1" [opened, .moneyDeposited 90000 90000],
  .when ⟨.account, sam, .withdraw ⟨"a-1", 60000⟩⟩,
  .recorded .account "a-1" [.moneyWithdrawn 60000 30000],
  .call (.fraudScore "a-1" 60000),
  .answer (.fraudScore "a-1" 60000) ⟨95⟩,
  .recorded .account "a-1" [.accountFrozen "fraud risk 95" (.system "FraudReview")],
  .when ⟨.account, sam, .withdraw ⟨"a-1", 10⟩⟩,
  .rejected .account (.frozen "fraud risk 95") ]

def splitWithdrawals : Story := [
  .given .account "a-1" [opened, .moneyDeposited 90000 90000],
  .when ⟨.account, sam, .withdraw ⟨"a-1", 30000⟩⟩,
  .when ⟨.account, sam, .withdraw ⟨"a-1", 30000⟩⟩,
  .recorded .account "a-1" [.moneyWithdrawn 30000 60000, .moneyWithdrawn 30000 30000],
  .emitted DailyOutflow "a-1" [⟨0, 60000⟩],
  .call (.fraudScore "a-1" 60000),
  .answer (.fraudScore "a-1" 60000) ⟨10⟩,
  .recorded .account "a-1" [] ]

def closedWhileTheFraudCheckIsPending : Story := [
  .given .account "a-1" [opened, .moneyDeposited 60000 60000],
  .when ⟨.account, sam, .withdraw ⟨"a-1", 60000⟩⟩,
  .call (.fraudScore "a-1" 60000),
  .when ⟨.account, sam, .close ⟨"a-1"⟩⟩,
  .recorded .account "a-1" [.moneyWithdrawn 60000 0, .accountClosed],
  .answer (.fraudScore "a-1" 60000) ⟨95⟩,
  .recorded .account "a-1" [],
  .holds "the summary shows it closed" fun w => (AccountSummary.stateAt w.log "a-1").closed ]

def twoAccounts : Story := [
  .given .account "a-1" [opened "c-1", .moneyDeposited 100 100],
  .given .account "a-2" [opened "c-2"] ]

def aTransferCompletes : Story := twoAccounts ++ [
  .when ⟨.transfer, sam, .request ⟨"t-1", "a-1", "a-2", 40⟩⟩,
  .recorded .transfer "t-1" [.transferRequested ⟨"a-1", "a-2", 40, sam⟩ false, .transferCompleted],
  .recorded .account "a-1" [.transferDebited "t-1" 40 60],
  .recorded .account "a-2" [.transferCredited "t-1" 40 40],
  .saga "t-1" .completed,
  .holds "the status is completed" fun w =>
    (TransferStatus.stateAt w.log "t-1").progress = .completed,
  .emitted AccountTransfers "a-1" [⟨"t-1", 40, .outgoing⟩],
  .emitted AccountTransfers "a-2" [⟨"t-1", 40, .incoming⟩] ]

def someoneElsesMoney : Story := twoAccounts ++ [
  .when ⟨.transfer, alex, .request ⟨"t-1", "a-1", "a-2", 40⟩⟩,
  .recorded .transfer "t-1"
    [.transferRequested ⟨"a-1", "a-2", 40, alex⟩ false, .transferFailed "not your account"],
  .recorded .account "a-1" [],
  .saga "t-1" (.failed .notOwner) ]

def aLargeTransfer : Story := [
  .given .account "a-1" [opened "c-1", .moneyDeposited 50000 50000],
  .given .account "a-2" [opened "c-2"],
  .when ⟨.transfer, sam, .request ⟨"t-1", "a-1", "a-2", 20000⟩⟩,
  .recorded .transfer "t-1" [.transferRequested ⟨"a-1", "a-2", 20000, sam⟩ true],
  .saga "t-1" .running,
  .recorded .account "a-1" [],
  .when ⟨.transfer, sam, .approve ⟨"t-1"⟩⟩,
  .rejected .transfer .notPermitted,
  .when ⟨.transfer, support, .approve ⟨"t-1"⟩⟩,
  .recorded .transfer "t-1"
    [.transferApproved ⟨"a-1", "a-2", 20000, sam⟩ support, .transferCompleted],
  .recorded .account "a-1" [.transferDebited "t-1" 20000 30000],
  .recorded .account "a-2" [.transferCredited "t-1" 20000 20000],
  .saga "t-1" .completed,
  .pass 86400,
  .recorded .transfer "t-1" [] ]

def anUnapprovedTransferExpires : Story := [
  .given .account "a-1" [opened "c-1", .moneyDeposited 50000 50000],
  .given .account "a-2" [opened "c-2"],
  .when ⟨.transfer, sam, .request ⟨"t-1", "a-1", "a-2", 20000⟩⟩,
  .recorded .transfer "t-1" [.transferRequested ⟨"a-1", "a-2", 20000, sam⟩ true],
  .pass 86400,
  .recorded .transfer "t-1" [.transferFailed "not approved in time"],
  .recorded .account "a-1" [],
  .saga "t-1" .completed,
  .when ⟨.transfer, support, .approve ⟨"t-1"⟩⟩,
  .rejected .transfer .notAwaitingApproval ]

def aTransferToAClosedAccount : Story := [
  .given .account "a-1" [opened "c-1", .moneyDeposited 100 100],
  .given .account "a-2" [opened "c-2", .accountClosed],
  .when ⟨.transfer, sam, .request ⟨"t-1", "a-1", "a-2", 40⟩⟩,
  .recorded .account "a-1" [.transferDebited "t-1" 40 60, .transferRefunded "t-1" 40 100],
  .recorded .account "a-2" [],
  .recorded .transfer "t-1"
    [.transferRequested ⟨"a-1", "a-2", 40, sam⟩ false,
     .transferFailed "destination account not open"],
  .saga "t-1" (.failed .destinationClosed) ]

def aSettlementOnAClosedAccount : Story := [
  .given .account "a-1" [opened, .accountClosed],
  .when ⟨.account, .system "Payments", .recordSettlement ⟨"a-1", "st_1", 500⟩⟩,
  .recorded .account "a-1" [.settlementOnClosedAccount "st_1" 500],
  .call (.refund "st_1" 500),
  .answer (.refund "st_1" 500) ⟨"re_st_1"⟩ ]

def reassigning : Story := [
  .given .account "a-1" [opened "c-1", .moneyDeposited 100 100],
  .when ⟨.account, sam, .changeOwner ⟨"a-1", "c-2"⟩⟩,
  .rejected .account .notPermitted,
  .when ⟨.account, support, .changeOwner ⟨"a-1", "c-2"⟩⟩,
  .recorded .account "a-1" [.ownerChanged "c-1" "c-2" support],
  .view CustomerDashboard "c-1" { balances := [] },
  .view CustomerDashboard "c-2" { balances := [("a-1", 100)] },
  .emitted AccountActivity "a-1" [.ownerChanged "c-1" "c-2" support] ]

def theLedgerIsPrivate : Story := [
  .given .account "a-1" [opened "c-1", .moneyDeposited 100 100],
  .when ⟨.account, sam, .withdraw ⟨"a-1", 30⟩⟩,
  .recorded .account "a-1" [.moneyWithdrawn 30 70],
  .holds "the owner reads two rows" fun w =>
    match AccountLedger.ask sam w.log "a-1" with
    | .ok page => page.entries.map (fun row => (row.kind, row.amount, row.balanceAfter))
        = [(.deposit, 100, 100), (.withdrawal, 30, 70)]
    | .error _ => false,
  .holds "an agent reads it" fun w => (AccountLedger.ask support w.log "a-1").isOk,
  .holds "another customer does not" fun w =>
    AccountLedger.ask alex w.log "a-1" matches .error .notOwner,
  .holds "a page of one row says where the next starts" fun w =>
    match AccountLedger.ask sam w.log "a-1" (take := 1) with
    | .ok page => page.entries.length = 1 ∧ page.cursor = some 1
    | .error _ => false ]

def theAccountCard : Story := [
  .given .account "a-1" [opened "c-1", .moneyDeposited 100 100],
  .when ⟨.account, sam, .withdraw ⟨"a-1", 30⟩⟩,
  .recorded .account "a-1" [.moneyWithdrawn 30 70],
  .holds "a card for every change" fun w =>
    AccountCard.entries w.log "a-1" = [⟨"c-1", "Sam", 100, false⟩, ⟨"c-1", "Sam", 70, false⟩],
  .holds "another customer cannot follow it" fun w =>
    AccountCard.read alex w.log "a-1" matches .error .notOwner ]

/-- Leaves the refund call unanswered. -/
def anUnansweredCall : Story := [
  .given .account "a-1" [opened, .accountClosed],
  .when ⟨.account, .system "Payments", .recordSettlement ⟨"a-1", "st_1", 500⟩⟩,
  .recorded .account "a-1" [.settlementOnClosedAccount "st_1" 500] ]

/-! Each story is run when this file compiles. `#eval Bank.story aStory` says why one fails. -/

example : Bank.passes registering = true := by decide
example : Bank.passes aTakenUsername = true := by decide
example : Bank.passes registeringSomeoneElse = true := by decide
example : Bank.passes withdrawing = true := by decide
example : Bank.passes anOverdraft = true := by decide
example : Bank.passes someoneElsesAccount = true := by decide
example : Bank.passes theDailyLimit = true := by decide
example : Bank.passes freezingTwice = true := by decide
example : Bank.passes aRiskyWithdrawal = true := by decide
example : Bank.passes splitWithdrawals = true := by decide
example : Bank.passes closedWhileTheFraudCheckIsPending = true := by decide
example : Bank.passes aTransferCompletes = true := by decide
example : Bank.passes someoneElsesMoney = true := by decide
example : Bank.passes aLargeTransfer = true := by decide
example : Bank.passes anUnapprovedTransferExpires = true := by decide
example : Bank.passes aTransferToAClosedAccount = true := by decide
example : Bank.passes aSettlementOnAClosedAccount = true := by decide
example : Bank.passes reassigning = true := by decide
example : Bank.passes theLedgerIsPrivate = true := by decide
example : Bank.passes theAccountCard = true := by decide

/-- A story that leaves a call unanswered fails. -/
example : Bank.passes anUnansweredCall = false := by decide

end Bank
