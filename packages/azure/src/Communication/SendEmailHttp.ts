import * as email from "@distilled.cloud/azure/communication-email";
import * as Layer from "effect/Layer";
import { CommunicationRole, makeCommunicationHttpBinding } from "./BindingHttp.ts";
import { SendEmail } from "./SendEmail.ts";

/**
 * Implementation of {@link SendEmail} over the distilled `communication-email`
 * data plane. Assigns the custom `AzureCommunicationDataRole` on the
 * communication service.
 *
 * @layer
 * @provides Azure.Communication.SendEmail
 */
export const SendEmailHttp = Layer.effect(
  SendEmail,
  makeCommunicationHttpBinding({
    tag: "Azure.Communication.SendEmail",
    operation: email.SendEmail,
    grant: CommunicationRole.Data,
  }),
);
