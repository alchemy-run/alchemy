import * as cw from "@distilled.cloud/gcp/contentwarehouse_v1";
import * as Layer from "effect/Layer";
import { makeRuleSetHttpBinding } from "./BindingHttp.ts";
import { GetRuleSet } from "./GetRuleSet.ts";

/**
 * HTTP implementation of {@link GetRuleSet}.
 *
 * @layer
 * @provides GCP.Contentwarehouse.GetRuleSet
 */
export const GetRuleSetHttp = Layer.effect(
  GetRuleSet,
  makeRuleSetHttpBinding({
    tag: "GCP.Contentwarehouse.GetRuleSet",
    operation: cw.getProjectsLocationsRuleSets,
  }),
);
