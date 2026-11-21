import * as translate from "@distilled.cloud/gcp/translate_v3";
import * as Layer from "effect/Layer";
import { AdaptiveMtTranslate, type AdaptiveMtTranslateRequest } from "./AdaptiveMtTranslate.ts";
import { locationParentOf, makeAdaptiveMtTranslateBinding } from "./BindingHttp.ts";

/**
 * HTTP implementation of {@link AdaptiveMtTranslate}.
 *
 * @layer
 * @provides GCP.Translate.AdaptiveMtTranslate
 */
export const AdaptiveMtTranslateHttp = Layer.effect(
  AdaptiveMtTranslate,
  makeAdaptiveMtTranslateBinding({
    tag: "GCP.Translate.AdaptiveMtTranslate",
    operation: translate.adaptiveMtTranslateProjectsLocations,
    iam: { role: "roles/cloudtranslate.user" },
    withBody: (name, request: AdaptiveMtTranslateRequest | undefined) => ({
      ...request?.body,
      dataset: name,
      parent: locationParentOf(name),
    }),
  }),
);
