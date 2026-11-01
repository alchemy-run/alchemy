import * as scf from "@distilled.cloud/stackit/scf";
import * as Layer from "effect/Layer";
import { makePlatformHttpBinding } from "./BindingHttp.ts";
import { ListPlatformQuotas } from "./ListPlatformQuotas.ts";

/**
 * HTTP implementation of {@link ListPlatformQuotas}.
 *
 * @layer
 * @provides Stackit.CloudFoundry.ListPlatformQuotas
 */
export const ListPlatformQuotasHttp = Layer.effect(
  ListPlatformQuotas,
  makePlatformHttpBinding({
    tag: "Stackit.CloudFoundry.ListPlatformQuotas",
    permissions: ["scf.platform.quota.list"],
    operation: scf.listPlatformQuotas,
  }),
);
