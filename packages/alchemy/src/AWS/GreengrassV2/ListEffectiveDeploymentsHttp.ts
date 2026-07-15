import * as greengrassv2 from "@distilled.cloud/aws/greengrassv2";
import * as Layer from "effect/Layer";
import { makeGreengrassAccountHttpBinding } from "./BindingHttp.ts";
import { ListEffectiveDeployments } from "./ListEffectiveDeployments.ts";

export const ListEffectiveDeploymentsHttp = Layer.effect(
  ListEffectiveDeployments,
  makeGreengrassAccountHttpBinding({
    tag: "AWS.GreengrassV2.ListEffectiveDeployments",
    operation: greengrassv2.listEffectiveDeployments,
    actions: ["greengrass:ListEffectiveDeployments"],
  }),
);
