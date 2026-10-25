import * as data from "@distilled.cloud/azure/confidentialledger-data";
import * as Layer from "effect/Layer";
import { makeLedgerListHttpBinding } from "./BindingHttp.ts";
import { ListTags } from "./ListTags.ts";

/**
 * Implementation of {@link ListTags} over the distilled
 * `confidentialledger-data` data plane. Gives the host the ledger role
 * **Reader** on the ledger.
 *
 * @layer
 * @provides Azure.ConfidentialLedger.ListTags
 */
export const ListTagsHttp = Layer.effect(
  ListTags,
  makeLedgerListHttpBinding({
    tag: "Azure.ConfidentialLedger.ListTags",
    operation: data.ListTags,
    role: "Reader",
  }),
);
