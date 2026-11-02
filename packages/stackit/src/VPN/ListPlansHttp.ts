import * as vpn from "@distilled.cloud/stackit/vpn";
import * as Layer from "effect/Layer";
import { makeUnscopedHttpBinding } from "./BindingHttp.ts";
import { ListPlans } from "./ListPlans.ts";

/**
 * HTTP implementation of {@link ListPlans}.
 *
 * @layer
 * @provides Stackit.VPN.ListPlans
 */
export const ListPlansHttp = Layer.effect(
  ListPlans,
  makeUnscopedHttpBinding({
    tag: "Stackit.VPN.ListPlans",
    operation: vpn.listPlans,
  }),
);
