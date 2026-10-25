import * as contentSafety from "@distilled.cloud/azure/cognitiveservices-content-safety";
import * as Layer from "effect/Layer";
import { ContentSafetyRole, makeAccountDataHttpBinding } from "./AccountDataBindingHttp.ts";
import { AddOrUpdateTextBlocklistItems } from "./AddOrUpdateTextBlocklistItems.ts";

/**
 * Implementation of {@link AddOrUpdateTextBlocklistItems} over the distilled `cognitiveservices-content-safety`
 * data plane. Assigns the custom `AzureCognitiveServicesContentSafetyWriteBlocklistsRole` on the account.
 *
 * @layer
 * @provides Azure.CognitiveServices.AddOrUpdateTextBlocklistItems
 */
export const AddOrUpdateTextBlocklistItemsHttp = Layer.effect(
  AddOrUpdateTextBlocklistItems,
  makeAccountDataHttpBinding({
    tag: "Azure.CognitiveServices.AddOrUpdateTextBlocklistItems",
    operation: contentSafety.TextBlocklistsAddOrUpdateBlocklistItems,
    grant: ContentSafetyRole.WriteBlocklists,
  }),
);
