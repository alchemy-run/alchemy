import * as iaas from "@distilled.cloud/stackit/iaas";
import * as Layer from "effect/Layer";
import { AssociatePublicIp } from "./AssociatePublicIp.ts";
import { makePublicIpHttpBinding } from "./BindingHttp.ts";

/**
 * HTTP implementation of {@link AssociatePublicIp}.
 *
 * @layer
 * @provides Stackit.IaaS.AssociatePublicIp
 */
export const AssociatePublicIpHttp = Layer.effect(
  AssociatePublicIp,
  makePublicIpHttpBinding({
    tag: "Stackit.IaaS.AssociatePublicIp",
    access: { permissions: ["iaas.public-ip.update"] },
    operation: iaas.updatePublicIP,
  }),
);
