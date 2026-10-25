import * as contentSafety from "@distilled.cloud/azure/cognitiveservices-content-safety";
import * as Layer from "effect/Layer";
import { ContentSafetyRole, makeAccountDataHttpBinding } from "./AccountDataBindingHttp.ts";
import { ListTextBlocklists } from "./ListTextBlocklists.ts";

/**
 * Implementation of {@link ListTextBlocklists} over the distilled `cognitiveservices-content-safety`
 * data plane. Assigns the custom `AzureCognitiveServicesContentSafetyReadBlocklistsRole` on the account.
 *
 * @layer
 * @provides Azure.CognitiveServices.ListTextBlocklists
 */
export const ListTextBlocklistsHttp = Layer.effect(
  ListTextBlocklists,
  makeAccountDataHttpBinding({
    tag: "Azure.CognitiveServices.ListTextBlocklists",
    operation: contentSafety.ListTextBlocklistTextBlocklists,
    grant: ContentSafetyRole.ReadBlocklists,
  }),
);
