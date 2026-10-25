import * as data from "@distilled.cloud/azure/confidentialledger-data";
import * as Layer from "effect/Layer";
import { makeLedgerHttpBinding } from "./BindingHttp.ts";
import { ListLedgerEntries } from "./ListLedgerEntries.ts";

/**
 * Implementation of {@link ListLedgerEntries} over the distilled
 * `confidentialledger-data` data plane. Gives the host the ledger role
 * **Reader** on the ledger.
 *
 * @layer
 * @provides Azure.ConfidentialLedger.ListLedgerEntries
 */
export const ListLedgerEntriesHttp = Layer.effect(
  ListLedgerEntries,
  makeLedgerHttpBinding({
    tag: "Azure.ConfidentialLedger.ListLedgerEntries",
    operation: data.ListLedgerEntries,
    role: "Reader",
  }),
);
