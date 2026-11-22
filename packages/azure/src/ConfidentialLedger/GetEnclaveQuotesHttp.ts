import * as data from "@distilled.cloud/azure/confidentialledger-data";
import * as Layer from "effect/Layer";
import { makeLedgerHttpBinding } from "./BindingHttp.ts";
import { GetEnclaveQuotes } from "./GetEnclaveQuotes.ts";

/**
 * Implementation of {@link GetEnclaveQuotes} over the distilled
 * `confidentialledger-data` data plane. Gives the host the ledger role
 * **Reader** on the ledger.
 *
 * @layer
 * @provides Azure.ConfidentialLedger.GetEnclaveQuotes
 */
export const GetEnclaveQuotesHttp = Layer.effect(
  GetEnclaveQuotes,
  makeLedgerHttpBinding({
    tag: "Azure.ConfidentialLedger.GetEnclaveQuotes",
    operation: data.GetEnclaveQuotes,
    role: "Reader",
  }),
);
