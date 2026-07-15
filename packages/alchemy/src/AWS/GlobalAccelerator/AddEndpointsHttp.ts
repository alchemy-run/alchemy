import * as ga from "@distilled.cloud/aws/global-accelerator";
import * as Layer from "effect/Layer";
import { AddEndpoints } from "./AddEndpoints.ts";
import { makeGaEndpointGroupHttpBinding } from "./BindingHttp.ts";

export const AddEndpointsHttp = Layer.effect(
  AddEndpoints,
  makeGaEndpointGroupHttpBinding({
    tag: "AWS.GlobalAccelerator.AddEndpoints",
    operation: ga.addEndpoints,
    actions: ["globalaccelerator:AddEndpoints"],
  }),
);
