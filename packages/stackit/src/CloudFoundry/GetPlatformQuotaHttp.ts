import * as scf from "@distilled.cloud/stackit/scf";
import * as Layer from "effect/Layer";
import { makePlatformHttpBinding } from "./BindingHttp.ts";
import { GetPlatformQuota } from "./GetPlatformQuota.ts";

/**
 * HTTP implementation of {@link GetPlatformQuota}.
 *
 * @layer
 * @provides Stackit.CloudFoundry.GetPlatformQuota
 */
export const GetPlatformQuotaHttp = Layer.effect(
  GetPlatformQuota,
  makePlatformHttpBinding({
    tag: "Stackit.CloudFoundry.GetPlatformQuota",
    permissions: ["scf.platform.quota.get"],
    operation: scf.getPlatformQuota,
  }),
);
