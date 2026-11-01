import * as scf from "@distilled.cloud/stackit/scf";
import * as Layer from "effect/Layer";
import { makePlatformHttpBinding } from "./BindingHttp.ts";
import { GetPlatform } from "./GetPlatform.ts";

/**
 * HTTP implementation of {@link GetPlatform}.
 *
 * @layer
 * @provides Stackit.CloudFoundry.GetPlatform
 */
export const GetPlatformHttp = Layer.effect(
  GetPlatform,
  makePlatformHttpBinding({
    tag: "Stackit.CloudFoundry.GetPlatform",
    permissions: ["scf.platform.get"],
    operation: scf.getPlatform,
  }),
);
