import * as waf from "@distilled.cloud/stackit/alb_waf";
import * as Layer from "effect/Layer";
import { makeConfigurationHttpBinding } from "./BindingHttp.ts";
import { GetConfiguration } from "./GetConfiguration.ts";

/**
 * HTTP implementation of {@link GetConfiguration}.
 *
 * @layer
 * @provides Stackit.WAF.GetConfiguration
 */
export const GetConfigurationHttp = Layer.effect(
  GetConfiguration,
  makeConfigurationHttpBinding({
    tag: "Stackit.WAF.GetConfiguration",
    access: { permissions: ["alb.waf.get"] },
    operation: waf.getWAF,
  }),
);
