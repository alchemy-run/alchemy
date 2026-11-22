import * as data from "@distilled.cloud/azure/confidentialledger-data";
import * as Layer from "effect/Layer";
import { makeLedgerHttpBinding } from "./BindingHttp.ts";
import { GetLedgerEntry } from "./GetLedgerEntry.ts";

/**
 * Implementation of {@link GetLedgerEntry} over the distilled
 * `confidentialledger-data` data plane. Gives the host the ledger role
 * **Reader** on the ledger.
 *
 * @layer
 * @provides Azure.ConfidentialLedger.GetLedgerEntry
 */
export const GetLedgerEntryHttp = Layer.effect(
  GetLedgerEntry,
  makeLedgerHttpBinding({
    tag: "Azure.ConfidentialLedger.GetLedgerEntry",
    operation: data.GetLedgerEntry,
    role: "Reader",
  }),
);
