import * as sca from "@distilled.cloud/stackit/sca";
import * as Layer from "effect/Layer";
import { makeApplicationHttpBinding } from "./BindingHttp.ts";
import { GetApplicationLogs } from "./GetApplicationLogs.ts";

/**
 * HTTP implementation of {@link GetApplicationLogs}.
 *
 * @layer
 * @provides Stackit.ContainerApplications.GetApplicationLogs
 */
export const GetApplicationLogsHttp = Layer.effect(
  GetApplicationLogs,
  makeApplicationHttpBinding({
    tag: "Stackit.ContainerApplications.GetApplicationLogs",
    permissions: ["sca.application.get"],
    operation: sca.getApplicationLogs,
  }),
);
