import * as cw from "@distilled.cloud/gcp/contentwarehouse_v1";
import * as Layer from "effect/Layer";
import { makeSynonymSetHttpBinding } from "./BindingHttp.ts";
import { GetSynonymSet } from "./GetSynonymSet.ts";

/**
 * HTTP implementation of {@link GetSynonymSet}.
 *
 * @layer
 * @provides GCP.Contentwarehouse.GetSynonymSet
 */
export const GetSynonymSetHttp = Layer.effect(
  GetSynonymSet,
  makeSynonymSetHttpBinding({
    tag: "GCP.Contentwarehouse.GetSynonymSet",
    operation: cw.getProjectsLocationsSynonymSets,
  }),
);
