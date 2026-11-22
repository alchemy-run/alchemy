import * as messages from "@distilled.cloud/azure/communication-messages";
import * as Layer from "effect/Layer";
import { CommunicationRole, makeCommunicationHttpBinding } from "./BindingHttp.ts";
import { ListMessageTemplates } from "./ListMessageTemplates.ts";

/**
 * Implementation of {@link ListMessageTemplates} over the distilled
 * `communication-messages` data plane. Assigns the custom
 * `AzureCommunicationDataRole` on the communication service.
 *
 * @layer
 * @provides Azure.Communication.ListMessageTemplates
 */
export const ListMessageTemplatesHttp = Layer.effect(
  ListMessageTemplates,
  makeCommunicationHttpBinding({
    tag: "Azure.Communication.ListMessageTemplates",
    operation: messages.ListTemplateOperationTemplates,
    grant: CommunicationRole.Data,
  }),
);
