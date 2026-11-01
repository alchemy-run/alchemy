import * as waf from "@distilled.cloud/stackit/alb_waf";
import * as Layer from "effect/Layer";
import { makeScopeHttpBinding } from "../LoadBalancer/BindingHttp.ts";
import { ListConfigurations } from "./ListConfigurations.ts";

/**
 * HTTP implementation of {@link ListConfigurations}.
 *
 * @layer
 * @provides Stackit.WAF.ListConfigurations
 */
export const ListConfigurationsHttp = Layer.effect(
  ListConfigurations,
  makeScopeHttpBinding({
    tag: "Stackit.WAF.ListConfigurations",
    access: { permissions: ["alb.waf.list"] },
    operation: waf.listWAF,
  }),
);
