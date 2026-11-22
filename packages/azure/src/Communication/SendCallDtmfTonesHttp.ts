import * as callAutomation from "@distilled.cloud/azure/communication-call-automation";
import * as Layer from "effect/Layer";
import { CommunicationRole, makeCommunicationHttpBinding } from "./BindingHttp.ts";
import { SendCallDtmfTones } from "./SendCallDtmfTones.ts";

/**
 * Implementation of {@link SendCallDtmfTones} over the distilled
 * `communication-call-automation` data plane. Assigns the custom
 * `AzureCommunicationDataRole` on the communication service.
 *
 * @layer
 * @provides Azure.Communication.SendCallDtmfTones
 */
export const SendCallDtmfTonesHttp = Layer.effect(
  SendCallDtmfTones,
  makeCommunicationHttpBinding({
    tag: "Azure.Communication.SendCallDtmfTones",
    operation: callAutomation.SendCallMediaDtmfTones,
    grant: CommunicationRole.Data,
  }),
);
