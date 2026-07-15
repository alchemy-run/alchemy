import * as greengrassv2 from "@distilled.cloud/aws/greengrassv2";
import * as Layer from "effect/Layer";
import { makeGreengrassAccountHttpBinding } from "./BindingHttp.ts";
import { ListDeployments } from "./ListDeployments.ts";

export const ListDeploymentsHttp = Layer.effect(
  ListDeployments,
  makeGreengrassAccountHttpBinding({
    tag: "AWS.GreengrassV2.ListDeployments",
    operation: greengrassv2.listDeployments,
    actions: ["greengrass:ListDeployments"],
  }),
);
