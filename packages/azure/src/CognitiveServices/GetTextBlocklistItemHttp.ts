import * as contentSafety from "@distilled.cloud/azure/cognitiveservices-content-safety";
import * as Layer from "effect/Layer";
import { ContentSafetyRole, makeAccountDataHttpBinding } from "./AccountDataBindingHttp.ts";
import { GetTextBlocklistItem } from "./GetTextBlocklistItem.ts";

/**
 * Implementation of {@link GetTextBlocklistItem} over the distilled `cognitiveservices-content-safety`
 * data plane. Assigns the custom `AzureCognitiveServicesContentSafetyReadBlocklistItemsRole` on the account.
 *
 * @layer
 * @provides Azure.CognitiveServices.GetTextBlocklistItem
 */
export const GetTextBlocklistItemHttp = Layer.effect(
  GetTextBlocklistItem,
  makeAccountDataHttpBinding({
    tag: "Azure.CognitiveServices.GetTextBlocklistItem",
    operation: contentSafety.GetTextBlocklistTextBlocklistItem,
    grant: ContentSafetyRole.ReadBlocklistItems,
  }),
);
