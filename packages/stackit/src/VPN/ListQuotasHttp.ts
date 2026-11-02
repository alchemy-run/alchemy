import * as vpn from "@distilled.cloud/stackit/vpn";
import * as Layer from "effect/Layer";
import { makeScopeHttpBinding } from "./BindingHttp.ts";
import { ListQuotas } from "./ListQuotas.ts";

/**
 * HTTP implementation of {@link ListQuotas}.
 *
 * @layer
 * @provides Stackit.VPN.ListQuotas
 */
export const ListQuotasHttp = Layer.effect(
  ListQuotas,
  makeScopeHttpBinding({
    tag: "Stackit.VPN.ListQuotas",
    permissions: ["vpn.quota.get"],
    operation: vpn.listQuotas,
  }),
);
