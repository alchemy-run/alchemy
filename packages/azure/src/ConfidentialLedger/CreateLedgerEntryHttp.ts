import * as data from "@distilled.cloud/azure/confidentialledger-data";
import * as Layer from "effect/Layer";
import { makeLedgerHttpBinding } from "./BindingHttp.ts";
import { CreateLedgerEntry } from "./CreateLedgerEntry.ts";

/**
 * Implementation of {@link CreateLedgerEntry} over the distilled
 * `confidentialledger-data` data plane. Gives the host the ledger role
 * **Contributor** on the ledger.
 *
 * @layer
 * @provides Azure.ConfidentialLedger.CreateLedgerEntry
 */
export const CreateLedgerEntryHttp = Layer.effect(
  CreateLedgerEntry,
  makeLedgerHttpBinding({
    tag: "Azure.ConfidentialLedger.CreateLedgerEntry",
    operation: data.CreateLedgerEntry,
    role: "Contributor",
  }),
);
