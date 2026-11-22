import * as data from "@distilled.cloud/azure/confidentialledger-data";
import * as Layer from "effect/Layer";
import { makeLedgerListHttpBinding } from "./BindingHttp.ts";
import { ListCollections } from "./ListCollections.ts";

/**
 * Implementation of {@link ListCollections} over the distilled
 * `confidentialledger-data` data plane. Gives the host the ledger role
 * **Reader** on the ledger.
 *
 * @layer
 * @provides Azure.ConfidentialLedger.ListCollections
 */
export const ListCollectionsHttp = Layer.effect(
  ListCollections,
  makeLedgerListHttpBinding({
    tag: "Azure.ConfidentialLedger.ListCollections",
    operation: data.ListCollections,
    role: "Reader",
  }),
);
