import * as greengrassv2 from "@distilled.cloud/aws/greengrassv2";
import * as Layer from "effect/Layer";
import { makeGreengrassDeploymentHttpBinding } from "./BindingHttp.ts";
import { CancelDeployment } from "./CancelDeployment.ts";

export const CancelDeploymentHttp = Layer.effect(
  CancelDeployment,
  makeGreengrassDeploymentHttpBinding({
    tag: "AWS.GreengrassV2.CancelDeployment",
    operation: greengrassv2.cancelDeployment,
    actions: ["greengrass:CancelDeployment"],
  }),
);
