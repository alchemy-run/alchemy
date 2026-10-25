import * as Layer from "effect/Layer";
import { makeLedgerIdentityHttpBinding } from "./BindingHttp.ts";
import { GetLedgerIdentity } from "./GetLedgerIdentity.ts";

/**
 * Implementation of {@link GetLedgerIdentity} over the distilled
 * `confidentialledger-identity` service. Grants nothing (the service is
 * anonymous).
 *
 * @layer
 * @provides Azure.ConfidentialLedger.GetLedgerIdentity
 */
export const GetLedgerIdentityHttp = Layer.effect(
  GetLedgerIdentity,
  makeLedgerIdentityHttpBinding("Azure.ConfidentialLedger.GetLedgerIdentity"),
);
