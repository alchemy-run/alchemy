import * as fms from "@distilled.cloud/aws/fms";
import * as Layer from "effect/Layer";
import { makeFmsHttpBinding } from "./BindingHttp.ts";
import { GetThirdPartyFirewallAssociationStatus } from "./GetThirdPartyFirewallAssociationStatus.ts";

export const GetThirdPartyFirewallAssociationStatusHttp = Layer.effect(
  GetThirdPartyFirewallAssociationStatus,
  makeFmsHttpBinding<
    fms.GetThirdPartyFirewallAssociationStatusRequest,
    fms.GetThirdPartyFirewallAssociationStatusResponse,
    fms.GetThirdPartyFirewallAssociationStatusError
  >({
    capability: "GetThirdPartyFirewallAssociationStatus",
    iamActions: ["fms:GetThirdPartyFirewallAssociationStatus"],
    operation: fms.getThirdPartyFirewallAssociationStatus,
  }),
);
