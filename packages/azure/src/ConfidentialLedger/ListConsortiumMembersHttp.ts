import * as data from "@distilled.cloud/azure/confidentialledger-data";
import * as Layer from "effect/Layer";
import { makeLedgerListHttpBinding } from "./BindingHttp.ts";
import { ListConsortiumMembers } from "./ListConsortiumMembers.ts";

/**
 * Implementation of {@link ListConsortiumMembers} over the distilled
 * `confidentialledger-data` data plane. Gives the host the ledger role
 * **Reader** on the ledger.
 *
 * @layer
 * @provides Azure.ConfidentialLedger.ListConsortiumMembers
 */
export const ListConsortiumMembersHttp = Layer.effect(
  ListConsortiumMembers,
  makeLedgerListHttpBinding({
    tag: "Azure.ConfidentialLedger.ListConsortiumMembers",
    operation: data.ListConsortiumMembers,
    role: "Reader",
  }),
);
