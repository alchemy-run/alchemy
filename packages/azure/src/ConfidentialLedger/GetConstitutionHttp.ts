import * as data from "@distilled.cloud/azure/confidentialledger-data";
import * as Layer from "effect/Layer";
import { makeLedgerHttpBinding } from "./BindingHttp.ts";
import { GetConstitution } from "./GetConstitution.ts";

/**
 * Implementation of {@link GetConstitution} over the distilled
 * `confidentialledger-data` data plane. Gives the host the ledger role
 * **Reader** on the ledger.
 *
 * @layer
 * @provides Azure.ConfidentialLedger.GetConstitution
 */
export const GetConstitutionHttp = Layer.effect(
  GetConstitution,
  makeLedgerHttpBinding({
    tag: "Azure.ConfidentialLedger.GetConstitution",
    operation: data.GetConstitution,
    role: "Reader",
  }),
);
