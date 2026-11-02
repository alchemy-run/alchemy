import * as scf from "@distilled.cloud/stackit/scf";
import * as Layer from "effect/Layer";
import { makeSpaceHttpBinding } from "./BindingHttp.ts";
import { GetSpace } from "./GetSpace.ts";

/**
 * HTTP implementation of {@link GetSpace}.
 *
 * @layer
 * @provides Stackit.CloudFoundry.GetSpace
 */
export const GetSpaceHttp = Layer.effect(
  GetSpace,
  makeSpaceHttpBinding({
    tag: "Stackit.CloudFoundry.GetSpace",
    permissions: ["scf.space.get"],
    operation: scf.getSpace,
  }),
);
