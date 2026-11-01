import * as ipLists from "@distilled.cloud/stackit/lb_ip_lists";
import * as Layer from "effect/Layer";
import { makeScopeHttpBinding } from "../LoadBalancer/BindingHttp.ts";
import { ListIPLists } from "./ListIPLists.ts";

/**
 * HTTP implementation of {@link ListIPLists}.
 *
 * @layer
 * @provides Stackit.IPLists.ListIPLists
 */
export const ListIPListsHttp = Layer.effect(
  ListIPLists,
  makeScopeHttpBinding({
    tag: "Stackit.IPLists.ListIPLists",
    access: { permissions: ["lb-ip-lists.loadbalancer.list"] },
    operation: ipLists.listIPLists,
  }),
);
