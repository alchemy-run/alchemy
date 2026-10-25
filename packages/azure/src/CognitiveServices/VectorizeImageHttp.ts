import * as uv from "@distilled.cloud/azure/cognitiveservices-unified-vision";
import * as Layer from "effect/Layer";
import {
  CognitivePath,
  CognitiveRole,
  makeCognitiveHttpBinding,
} from "./SpeechTranslatorVisionHttp.ts";
import { VectorizeImage } from "./VectorizeImage.ts";

/**
 * Implementation of {@link VectorizeImage} over the distilled `cognitiveservices-unified-vision`
 * data plane. Assigns the custom `AzureCognitiveVectorizeImageRole` on the account.
 *
 * @layer
 * @provides Azure.CognitiveServices.VectorizeImage
 */
export const VectorizeImageHttp = Layer.effect(
  VectorizeImage,
  makeCognitiveHttpBinding({
    tag: "Azure.CognitiveServices.VectorizeImage",
    operation: uv.VectorizeImage,
    path: CognitivePath.vision,
    grant: CognitiveRole.VectorizeImage,
  }),
);
