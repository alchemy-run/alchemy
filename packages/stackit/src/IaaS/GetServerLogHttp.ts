import * as iaas from "@distilled.cloud/stackit/iaas";
import * as Layer from "effect/Layer";
import { makeServerHttpBinding } from "./BindingHttp.ts";
import { GetServerLog } from "./GetServerLog.ts";

/**
 * HTTP implementation of {@link GetServerLog}.
 *
 * @layer
 * @provides Stackit.IaaS.GetServerLog
 */
export const GetServerLogHttp = Layer.effect(
  GetServerLog,
  makeServerHttpBinding({
    tag: "Stackit.IaaS.GetServerLog",
    access: { permissions: ["iaas.server.console-log.get"] },
    operation: iaas.getServerLog,
  }),
);
