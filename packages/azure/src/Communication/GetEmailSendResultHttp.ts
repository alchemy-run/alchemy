import * as email from "@distilled.cloud/azure/communication-email";
import * as Layer from "effect/Layer";
import { CommunicationRole, makeCommunicationHttpBinding } from "./BindingHttp.ts";
import { GetEmailSendResult } from "./GetEmailSendResult.ts";

/**
 * Implementation of {@link GetEmailSendResult} over the distilled `communication-email`
 * data plane. Assigns the custom `AzureCommunicationDataRole` on the
 * communication service.
 *
 * @layer
 * @provides Azure.Communication.GetEmailSendResult
 */
export const GetEmailSendResultHttp = Layer.effect(
  GetEmailSendResult,
  makeCommunicationHttpBinding({
    tag: "Azure.Communication.GetEmailSendResult",
    operation: email.EmailGetSendResult,
    grant: CommunicationRole.Data,
  }),
);
