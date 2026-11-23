import Alchemy
import Bank.Model

open Alchemy

namespace Bank

/-- What customers send and read. -/
def CustomerApi : Api Bank where
  name := "CustomerApi"
  accepts
    | ⟨.account, _, .deposit _⟩ | ⟨.account, _, .withdraw _⟩ | ⟨.account, _, .close _⟩
    | ⟨.transfer, _, .request _⟩ => true
    | _ => false
  decisions := [Registration]
  views := [CustomerDashboard, AccountSummary, Statement, AccountTransfers, TransferStatus]
  streams := [AccountCard]
  queries := [AccountLedger]

/-- What support agents send and read. -/
def SupportApi : Api Bank where
  name := "SupportApi"
  accepts
    | ⟨.account, _, .freeze _⟩ | ⟨.account, _, .changeOwner _⟩ | ⟨.transfer, _, .approve _⟩ => true
    | _ => false
  views := [AccountSummary, AccountActivity]
  queries := [AccountLedger]

/-- A customer cannot credit an account through their Api. -/
example :
    (CustomerApi.send (World.start BankSignature)
      ⟨.account, .customer "c-1", .creditTransfer ⟨"a-1", "t-1", 100⟩⟩).isNone = true := by decide

end Bank
