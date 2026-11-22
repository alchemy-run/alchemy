import * as contentSafety from "@distilled.cloud/azure/cognitiveservices-content-safety";
import * as Layer from "effect/Layer";
import { ContentSafetyRole, makeAccountDataHttpBinding } from "./AccountDataBindingHttp.ts";
import { CreateOrUpdateTextBlocklist } from "./CreateOrUpdateTextBlocklist.ts";

/**
 * Implementation of {@link CreateOrUpdateTextBlocklist} over the distilled `cognitiveservices-content-safety`
 * data plane. Assigns the custom `AzureCognitiveServicesContentSafetyWriteBlocklistsRole` on the account.
 *
 * @layer
 * @provides Azure.CognitiveServices.CreateOrUpdateTextBlocklist
 */
export const CreateOrUpdateTextBlocklistHttp = Layer.effect(
  CreateOrUpdateTextBlocklist,
  makeAccountDataHttpBinding({
    tag: "Azure.CognitiveServices.CreateOrUpdateTextBlocklist",
    operation: contentSafety.TextBlocklistsCreateOrUpdateTextBlocklist,
    grant: ContentSafetyRole.WriteBlocklists,
  }),
);
