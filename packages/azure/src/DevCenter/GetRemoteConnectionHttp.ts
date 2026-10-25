import * as devcenter from "@distilled.cloud/azure/devcenter-data";
import * as Layer from "effect/Layer";
import { makeProjectUserHttpBinding, DevCenterRole } from "./BindingHttp.ts";
import { GetRemoteConnection } from "./GetRemoteConnection.ts";

/**
 * Implementation of {@link GetRemoteConnection} over the distilled
 * `devcenter-data` data plane. Assigns the custom
 * `AzureDevCenterDevBoxRemoteConnectionRole` on the project.
 *
 * @layer
 * @provides Azure.DevCenter.GetRemoteConnection
 */
export const GetRemoteConnectionHttp = Layer.effect(
  GetRemoteConnection,
  makeProjectUserHttpBinding({
    tag: "Azure.DevCenter.GetRemoteConnection",
    operation: devcenter.GetDevBoxRemoteConnection,
    grants: [DevCenterRole.DevBoxRemoteConnection],
  }),
);
