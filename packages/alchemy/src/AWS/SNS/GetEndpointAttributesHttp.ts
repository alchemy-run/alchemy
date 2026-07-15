import * as sns from "@distilled.cloud/aws/sns";
import * as Layer from "effect/Layer";
import { makeSnsPlatformHttpBinding } from "./BindingHttp.ts";
import { GetEndpointAttributes } from "./GetEndpointAttributes.ts";

export const GetEndpointAttributesHttp = Layer.effect(
  GetEndpointAttributes,
  makeSnsPlatformHttpBinding({
    tag: "AWS.SNS.GetEndpointAttributes",
    operation: sns.getEndpointAttributes,
    actions: ["sns:GetEndpointAttributes"],
    injectArn: false,
  }),
);
