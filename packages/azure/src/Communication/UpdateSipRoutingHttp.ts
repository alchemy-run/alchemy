import * as sipRouting from "@distilled.cloud/azure/communication-sip-routing";
import * as Layer from "effect/Layer";
import { CommunicationRole, makeCommunicationHttpBinding } from "./BindingHttp.ts";
import { UpdateSipRouting } from "./UpdateSipRouting.ts";

/**
 * Implementation of {@link UpdateSipRouting} over the distilled
 * `communication-sip-routing` data plane. Assigns the custom
 * `AzureCommunicationDataRole` on the communication service.
 *
 * @layer
 * @provides Azure.Communication.UpdateSipRouting
 */
export const UpdateSipRoutingHttp = Layer.effect(
  UpdateSipRouting,
  makeCommunicationHttpBinding({
    tag: "Azure.Communication.UpdateSipRouting",
    operation: sipRouting.UpdateSipRouting,
    grant: CommunicationRole.Data,
  }),
);
