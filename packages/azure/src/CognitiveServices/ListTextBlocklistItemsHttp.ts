import * as contentSafety from "@distilled.cloud/azure/cognitiveservices-content-safety";
import * as Layer from "effect/Layer";
import { ContentSafetyRole, makeAccountDataHttpBinding } from "./AccountDataBindingHttp.ts";
import { ListTextBlocklistItems } from "./ListTextBlocklistItems.ts";

/**
 * Implementation of {@link ListTextBlocklistItems} over the distilled `cognitiveservices-content-safety`
 * data plane. Assigns the custom `AzureCognitiveServicesContentSafetyReadBlocklistItemsRole` on the account.
 *
 * @layer
 * @provides Azure.CognitiveServices.ListTextBlocklistItems
 */
export const ListTextBlocklistItemsHttp = Layer.effect(
  ListTextBlocklistItems,
  makeAccountDataHttpBinding({
    tag: "Azure.CognitiveServices.ListTextBlocklistItems",
    operation: contentSafety.ListTextBlocklistTextBlocklistItems,
    grant: ContentSafetyRole.ReadBlocklistItems,
  }),
);
