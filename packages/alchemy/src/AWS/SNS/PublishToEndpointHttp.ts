import * as sns from "@distilled.cloud/aws/sns";
import * as Layer from "effect/Layer";
import { makeSnsPlatformHttpBinding } from "./BindingHttp.ts";
import { PublishToEndpoint } from "./PublishToEndpoint.ts";

export const PublishToEndpointHttp = Layer.effect(
  PublishToEndpoint,
  makeSnsPlatformHttpBinding({
    tag: "AWS.SNS.PublishToEndpoint",
    operation: sns.publish,
    actions: ["sns:Publish"],
    injectArn: false,
  }),
);
