import * as sns from "@distilled.cloud/aws/sns";
import * as Layer from "effect/Layer";
import { makeSnsPlatformHttpBinding } from "./BindingHttp.ts";
import { DeleteEndpoint } from "./DeleteEndpoint.ts";

export const DeleteEndpointHttp = Layer.effect(
  DeleteEndpoint,
  makeSnsPlatformHttpBinding({
    tag: "AWS.SNS.DeleteEndpoint",
    operation: sns.deleteEndpoint,
    actions: ["sns:DeleteEndpoint"],
    injectArn: false,
  }),
);
