import * as greengrassv2 from "@distilled.cloud/aws/greengrassv2";
import * as Binding from "alchemy/Binding";
import type * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { makeGreengrassAccountHttpBinding } from "./BindingHttp.ts";

/**
 * Runtime binding for `greengrass:GetConnectivityInfo`.
 *
 * Reads a core device's connectivity information — the endpoints and ports
 * where client devices can reach the core's local MQTT broker (the same data
 * the IoT Greengrass discovery API serves). The caller supplies the core
 * device's thing name at runtime. Provide the implementation with
 * `Effect.provide(AWS.GreengrassV2.GetConnectivityInfoHttp)`.
 * ### Managing Client Devices
 * **Example:** Read A Core's Broker Endpoints
 * ```typescript
 * // init — account-level binding, no resource argument
 * const getConnectivityInfo = yield* AWS.GreengrassV2.GetConnectivityInfo();
 *
 * // runtime
 * const { connectivityInfo } = yield* getConnectivityInfo({
 *   thingName: "MyCore",
 * });
 * ```
 *
 * @binding
 */
export interface GetConnectivityInfo extends Binding.Service<
  GetConnectivityInfo,
  "AWS.GreengrassV2.GetConnectivityInfo",
  () => Effect.Effect<
    (
      request: greengrassv2.GetConnectivityInfoRequest,
    ) => Effect.Effect<
      greengrassv2.GetConnectivityInfoResponse,
      greengrassv2.GetConnectivityInfoError
    >
  >
> {}
export const GetConnectivityInfo = Binding.Service<GetConnectivityInfo>(
  "AWS.GreengrassV2.GetConnectivityInfo",
);

export const GetConnectivityInfoHttp = Layer.effect(
  GetConnectivityInfo,
  makeGreengrassAccountHttpBinding({
    tag: "AWS.GreengrassV2.GetConnectivityInfo",
    operation: greengrassv2.getConnectivityInfo,
    // Connectivity info is stored in IoT Core; Greengrass reads it with the
    // caller's credentials (documented dependent action).
    actions: ["greengrass:GetConnectivityInfo", "iot:GetThingShadow"],
  }),
);
