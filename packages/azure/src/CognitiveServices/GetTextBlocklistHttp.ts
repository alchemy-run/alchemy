import * as contentSafety from "@distilled.cloud/azure/cognitiveservices-content-safety";
import * as Layer from "effect/Layer";
import { ContentSafetyRole, makeAccountDataHttpBinding } from "./AccountDataBindingHttp.ts";
import { GetTextBlocklist } from "./GetTextBlocklist.ts";

/**
 * Implementation of {@link GetTextBlocklist} over the distilled `cognitiveservices-content-safety`
 * data plane. Assigns the custom `AzureCognitiveServicesContentSafetyReadBlocklistsRole` on the account.
 *
 * @layer
 * @provides Azure.CognitiveServices.GetTextBlocklist
 */
export const GetTextBlocklistHttp = Layer.effect(
  GetTextBlocklist,
  makeAccountDataHttpBinding({
    tag: "Azure.CognitiveServices.GetTextBlocklist",
    operation: contentSafety.GetTextBlocklistTextBlocklist,
    grant: ContentSafetyRole.ReadBlocklists,
  }),
);
