import * as iaas from "@distilled.cloud/stackit/iaas";
import * as Layer from "effect/Layer";
import { makeServerHttpBinding } from "./BindingHttp.ts";
import { UnrescueServer } from "./UnrescueServer.ts";

/**
 * HTTP implementation of {@link UnrescueServer}.
 *
 * @layer
 * @provides Stackit.IaaS.UnrescueServer
 */
export const UnrescueServerHttp = Layer.effect(
  UnrescueServer,
  makeServerHttpBinding({
    tag: "Stackit.IaaS.UnrescueServer",
    access: { permissions: ["iaas.server.unrescue"] },
    operation: iaas.unrescueServer,
  }),
);
