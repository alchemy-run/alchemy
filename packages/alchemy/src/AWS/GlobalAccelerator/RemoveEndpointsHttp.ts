import * as ga from "@distilled.cloud/aws/global-accelerator";
import * as Layer from "effect/Layer";
import { makeGaEndpointGroupHttpBinding } from "./BindingHttp.ts";
import { RemoveEndpoints } from "./RemoveEndpoints.ts";

export const RemoveEndpointsHttp = Layer.effect(
  RemoveEndpoints,
  makeGaEndpointGroupHttpBinding({
    tag: "AWS.GlobalAccelerator.RemoveEndpoints",
    operation: ga.removeEndpoints,
    actions: ["globalaccelerator:RemoveEndpoints"],
  }),
);
