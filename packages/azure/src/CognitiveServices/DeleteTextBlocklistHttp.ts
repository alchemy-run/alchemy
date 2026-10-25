import * as contentSafety from "@distilled.cloud/azure/cognitiveservices-content-safety";
import * as Layer from "effect/Layer";
import { ContentSafetyRole, makeAccountDataHttpBinding } from "./AccountDataBindingHttp.ts";
import { DeleteTextBlocklist } from "./DeleteTextBlocklist.ts";

/**
 * Implementation of {@link DeleteTextBlocklist} over the distilled `cognitiveservices-content-safety`
 * data plane. Assigns the custom `AzureCognitiveServicesContentSafetyDeleteBlocklistsRole` on the account.
 *
 * @layer
 * @provides Azure.CognitiveServices.DeleteTextBlocklist
 */
export const DeleteTextBlocklistHttp = Layer.effect(
  DeleteTextBlocklist,
  makeAccountDataHttpBinding({
    tag: "Azure.CognitiveServices.DeleteTextBlocklist",
    operation: contentSafety.DeleteTextBlocklistTextBlocklist,
    grant: ContentSafetyRole.DeleteBlocklists,
  }),
);
