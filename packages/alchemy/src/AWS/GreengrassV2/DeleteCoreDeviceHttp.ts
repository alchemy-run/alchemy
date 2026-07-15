import * as greengrassv2 from "@distilled.cloud/aws/greengrassv2";
import * as Layer from "effect/Layer";
import { makeGreengrassAccountHttpBinding } from "./BindingHttp.ts";
import { DeleteCoreDevice } from "./DeleteCoreDevice.ts";

export const DeleteCoreDeviceHttp = Layer.effect(
  DeleteCoreDevice,
  makeGreengrassAccountHttpBinding({
    tag: "AWS.GreengrassV2.DeleteCoreDevice",
    operation: greengrassv2.deleteCoreDevice,
    actions: ["greengrass:DeleteCoreDevice"],
  }),
);
