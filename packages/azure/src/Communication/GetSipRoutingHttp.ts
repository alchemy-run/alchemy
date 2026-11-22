import * as sipRouting from "@distilled.cloud/azure/communication-sip-routing";
import * as Layer from "effect/Layer";
import { CommunicationRole, makeCommunicationHttpBinding } from "./BindingHttp.ts";
import { GetSipRouting } from "./GetSipRouting.ts";

/**
 * Implementation of {@link GetSipRouting} over the distilled
 * `communication-sip-routing` data plane. Assigns the custom
 * `AzureCommunicationDataRole` on the communication service.
 *
 * @layer
 * @provides Azure.Communication.GetSipRouting
 */
export const GetSipRoutingHttp = Layer.effect(
  GetSipRouting,
  makeCommunicationHttpBinding({
    tag: "Azure.Communication.GetSipRouting",
    operation: sipRouting.GetSipRouting,
    grant: CommunicationRole.Data,
  }),
);
