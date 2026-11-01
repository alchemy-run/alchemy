import * as ipLists from "@distilled.cloud/stackit/lb_ip_lists";
import * as Layer from "effect/Layer";
import { makeIPListHttpBinding } from "./BindingHttp.ts";
import { GetIPList } from "./GetIPList.ts";

/**
 * HTTP implementation of {@link GetIPList}.
 *
 * @layer
 * @provides Stackit.IPLists.GetIPList
 */
export const GetIPListHttp = Layer.effect(
  GetIPList,
  makeIPListHttpBinding({
    tag: "Stackit.IPLists.GetIPList",
    access: { permissions: ["lb-ip-lists.loadbalancer.get"] },
    operation: ipLists.getIPList,
  }),
);
