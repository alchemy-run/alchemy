import * as iaas from "@distilled.cloud/stackit/iaas";
import * as Layer from "effect/Layer";
import { makeServerHttpBinding } from "./BindingHttp.ts";
import { RebootServer } from "./RebootServer.ts";

/**
 * HTTP implementation of {@link RebootServer}.
 *
 * @layer
 * @provides Stackit.IaaS.RebootServer
 */
export const RebootServerHttp = Layer.effect(
  RebootServer,
  makeServerHttpBinding({
    tag: "Stackit.IaaS.RebootServer",
    access: { permissions: ["iaas.server.reboot"] },
    operation: iaas.rebootServer,
  }),
);
