import * as iotw from "@distilled.cloud/aws/iot-wireless";
import * as Binding from "alchemy/Binding";
import type * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { makeIotWirelessAccountHttpBinding } from "./BindingHttp.ts";

/**
 * Runtime binding for `iotwireless:GetServiceEndpoint` — read the
 * account's CUPS or LNS endpoint (and its server trust certificate) from a
 * deployed Lambda or Task. Useful for gateway provisioning flows.
 *
 * ### Reading the Service Endpoint
 * Provide the `GetServiceEndpointHttp` implementation layer on the Function
 * effect, bind the capability in the init phase, then call the returned
 * client at runtime.
 *
 * **Example:** Read the LNS Endpoint
 * ```typescript
 * // init
 * const getEndpoint = yield* AWS.IoTWireless.GetServiceEndpoint();
 *
 * // runtime
 * const { ServiceEndpoint } = yield* getEndpoint({ ServiceType: "LNS" });
 * // on the Function effect:
 * // .pipe(Effect.provide(AWS.IoTWireless.GetServiceEndpointHttp))
 * ```
 *
 * @binding
 */
export interface GetServiceEndpoint extends Binding.Service<
  GetServiceEndpoint,
  "AWS.IoTWireless.GetServiceEndpoint",
  () => Effect.Effect<
    (
      request?: iotw.GetServiceEndpointRequest,
    ) => Effect.Effect<iotw.GetServiceEndpointResponse, iotw.GetServiceEndpointError>
  >
> {}
export const GetServiceEndpoint = Binding.Service<GetServiceEndpoint>(
  "AWS.IoTWireless.GetServiceEndpoint",
);

export const GetServiceEndpointHttp = Layer.effect(
  GetServiceEndpoint,
  makeIotWirelessAccountHttpBinding({
    capability: "GetServiceEndpoint",
    iamActions: ["iotwireless:GetServiceEndpoint"],
    operation: iotw.getServiceEndpoint,
    prepare: (request: iotw.GetServiceEndpointRequest | undefined) => request ?? {},
  }),
);
