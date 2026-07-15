import * as mediaconnect from "@distilled.cloud/aws/mediaconnect";
import * as Layer from "effect/Layer";
import { makeMediaConnectFlowHttpBinding } from "./BindingHttp.ts";
import { GrantFlowEntitlements } from "./GrantFlowEntitlements.ts";

export const GrantFlowEntitlementsHttp = Layer.effect(
  GrantFlowEntitlements,
  makeMediaConnectFlowHttpBinding({
    tag: "AWS.MediaConnect.GrantFlowEntitlements",
    operation: mediaconnect.grantFlowEntitlements,
    actions: ["mediaconnect:GrantFlowEntitlements"],
  }),
);
