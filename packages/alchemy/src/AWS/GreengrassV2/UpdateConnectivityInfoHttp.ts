import * as greengrassv2 from "@distilled.cloud/aws/greengrassv2";
import * as Layer from "effect/Layer";
import { makeGreengrassAccountHttpBinding } from "./BindingHttp.ts";
import { UpdateConnectivityInfo } from "./UpdateConnectivityInfo.ts";

export const UpdateConnectivityInfoHttp = Layer.effect(
  UpdateConnectivityInfo,
  makeGreengrassAccountHttpBinding({
    tag: "AWS.GreengrassV2.UpdateConnectivityInfo",
    operation: greengrassv2.updateConnectivityInfo,
    actions: ["greengrass:UpdateConnectivityInfo"],
  }),
);
