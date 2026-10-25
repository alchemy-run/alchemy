import * as data from "@distilled.cloud/azure/confidentialledger-data";
import * as Layer from "effect/Layer";
import { makeLedgerHttpBinding } from "./BindingHttp.ts";
import { GetReceipt } from "./GetReceipt.ts";

/**
 * Implementation of {@link GetReceipt} over the distilled
 * `confidentialledger-data` data plane. Gives the host the ledger role
 * **Reader** on the ledger.
 *
 * @layer
 * @provides Azure.ConfidentialLedger.GetReceipt
 */
export const GetReceiptHttp = Layer.effect(
  GetReceipt,
  makeLedgerHttpBinding({
    tag: "Azure.ConfidentialLedger.GetReceipt",
    operation: data.GetReceipt,
    role: "Reader",
  }),
);
