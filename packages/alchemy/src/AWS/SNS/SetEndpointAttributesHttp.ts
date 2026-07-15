import * as sns from "@distilled.cloud/aws/sns";
import * as Layer from "effect/Layer";
import { makeSnsPlatformHttpBinding } from "./BindingHttp.ts";
import { SetEndpointAttributes } from "./SetEndpointAttributes.ts";

export const SetEndpointAttributesHttp = Layer.effect(
  SetEndpointAttributes,
  makeSnsPlatformHttpBinding({
    tag: "AWS.SNS.SetEndpointAttributes",
    operation: sns.setEndpointAttributes,
    actions: ["sns:SetEndpointAttributes"],
    injectArn: false,
  }),
);
