import * as callAutomation from "@distilled.cloud/azure/communication-call-automation";
import * as Layer from "effect/Layer";
import { CommunicationRole, makeCommunicationHttpBinding } from "./BindingHttp.ts";
import { CancelAllCallMediaOperations } from "./CancelAllCallMediaOperations.ts";

/**
 * Implementation of {@link CancelAllCallMediaOperations} over the distilled
 * `communication-call-automation` data plane. Assigns the custom
 * `AzureCommunicationDataRole` on the communication service.
 *
 * @layer
 * @provides Azure.Communication.CancelAllCallMediaOperations
 */
export const CancelAllCallMediaOperationsHttp = Layer.effect(
  CancelAllCallMediaOperations,
  makeCommunicationHttpBinding({
    tag: "Azure.Communication.CancelAllCallMediaOperations",
    operation: callAutomation.CancelCallMediaAllMediaOperations,
    grant: CommunicationRole.Data,
  }),
);
