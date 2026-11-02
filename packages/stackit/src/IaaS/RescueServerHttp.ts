import * as iaas from "@distilled.cloud/stackit/iaas";
import * as Layer from "effect/Layer";
import { makeServerHttpBinding } from "./BindingHttp.ts";
import { RescueServer } from "./RescueServer.ts";

/**
 * HTTP implementation of {@link RescueServer}.
 *
 * @layer
 * @provides Stackit.IaaS.RescueServer
 */
export const RescueServerHttp = Layer.effect(
  RescueServer,
  makeServerHttpBinding({
    tag: "Stackit.IaaS.RescueServer",
    access: { permissions: ["iaas.server.rescue"] },
    operation: iaas.rescueServer,
  }),
);
