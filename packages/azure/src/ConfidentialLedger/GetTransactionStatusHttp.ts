import * as data from "@distilled.cloud/azure/confidentialledger-data";
import * as Layer from "effect/Layer";
import { makeLedgerHttpBinding } from "./BindingHttp.ts";
import { GetTransactionStatus } from "./GetTransactionStatus.ts";

/**
 * Implementation of {@link GetTransactionStatus} over the distilled
 * `confidentialledger-data` data plane. Gives the host the ledger role
 * **Reader** on the ledger.
 *
 * @layer
 * @provides Azure.ConfidentialLedger.GetTransactionStatus
 */
export const GetTransactionStatusHttp = Layer.effect(
  GetTransactionStatus,
  makeLedgerHttpBinding({
    tag: "Azure.ConfidentialLedger.GetTransactionStatus",
    operation: data.GetTransactionStatus,
    role: "Reader",
  }),
);
