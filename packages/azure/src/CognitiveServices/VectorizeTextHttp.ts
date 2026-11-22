import * as uv from "@distilled.cloud/azure/cognitiveservices-unified-vision";
import * as Layer from "effect/Layer";
import {
  CognitivePath,
  CognitiveRole,
  makeCognitiveHttpBinding,
} from "./SpeechTranslatorVisionHttp.ts";
import { VectorizeText } from "./VectorizeText.ts";

/**
 * Implementation of {@link VectorizeText} over the distilled `cognitiveservices-unified-vision`
 * data plane. Assigns the custom `AzureCognitiveVectorizeTextRole` on the account.
 *
 * @layer
 * @provides Azure.CognitiveServices.VectorizeText
 */
export const VectorizeTextHttp = Layer.effect(
  VectorizeText,
  makeCognitiveHttpBinding({
    tag: "Azure.CognitiveServices.VectorizeText",
    operation: uv.VectorizeText,
    path: CognitivePath.vision,
    grant: CognitiveRole.VectorizeText,
  }),
);
