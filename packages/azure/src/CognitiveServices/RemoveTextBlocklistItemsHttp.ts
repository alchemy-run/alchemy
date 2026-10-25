import * as contentSafety from "@distilled.cloud/azure/cognitiveservices-content-safety";
import * as Layer from "effect/Layer";
import { ContentSafetyRole, makeAccountDataHttpBinding } from "./AccountDataBindingHttp.ts";
import { RemoveTextBlocklistItems } from "./RemoveTextBlocklistItems.ts";

/**
 * Implementation of {@link RemoveTextBlocklistItems} over the distilled `cognitiveservices-content-safety`
 * data plane. Assigns the custom `AzureCognitiveServicesContentSafetyWriteBlocklistsRole` on the account.
 *
 * @layer
 * @provides Azure.CognitiveServices.RemoveTextBlocklistItems
 */
export const RemoveTextBlocklistItemsHttp = Layer.effect(
  RemoveTextBlocklistItems,
  makeAccountDataHttpBinding({
    tag: "Azure.CognitiveServices.RemoveTextBlocklistItems",
    operation: contentSafety.RemoveTextBlocklistBlocklistItems,
    grant: ContentSafetyRole.WriteBlocklists,
  }),
);
