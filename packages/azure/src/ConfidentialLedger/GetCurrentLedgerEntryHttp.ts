import * as data from "@distilled.cloud/azure/confidentialledger-data";
import * as Layer from "effect/Layer";
import { makeLedgerHttpBinding } from "./BindingHttp.ts";
import { GetCurrentLedgerEntry } from "./GetCurrentLedgerEntry.ts";

/**
 * Implementation of {@link GetCurrentLedgerEntry} over the distilled
 * `confidentialledger-data` data plane. Gives the host the ledger role
 * **Reader** on the ledger.
 *
 * @layer
 * @provides Azure.ConfidentialLedger.GetCurrentLedgerEntry
 */
export const GetCurrentLedgerEntryHttp = Layer.effect(
  GetCurrentLedgerEntry,
  makeLedgerHttpBinding({
    tag: "Azure.ConfidentialLedger.GetCurrentLedgerEntry",
    operation: data.GetCurrentLedgerEntry,
    role: "Reader",
  }),
);
