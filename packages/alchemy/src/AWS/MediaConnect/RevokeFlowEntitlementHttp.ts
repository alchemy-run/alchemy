import * as mediaconnect from "@distilled.cloud/aws/mediaconnect";
import * as Layer from "effect/Layer";
import { makeMediaConnectFlowHttpBinding } from "./BindingHttp.ts";
import { RevokeFlowEntitlement } from "./RevokeFlowEntitlement.ts";

export const RevokeFlowEntitlementHttp = Layer.effect(
  RevokeFlowEntitlement,
  makeMediaConnectFlowHttpBinding({
    tag: "AWS.MediaConnect.RevokeFlowEntitlement",
    operation: mediaconnect.revokeFlowEntitlement,
    actions: ["mediaconnect:RevokeFlowEntitlement"],
    // The IAM resource type for RevokeFlowEntitlement is the entitlement
    // ARN, which is a sibling of (not derived from) the flow ARN.
    starResource: true,
  }),
);
