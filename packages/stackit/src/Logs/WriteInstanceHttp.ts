import * as Layer from "effect/Layer";
import { makeWriteInstanceClient, makeLokiBinding } from "./BindingHttp.ts";
import { WriteInstance } from "./WriteInstance.ts";

/**
 * HTTP implementation of {@link WriteInstance}, on the instance's Grafana Loki API.
 *
 * @layer
 * @provides Stackit.Logs.WriteInstance
 */
export const WriteInstanceHttp = Layer.succeed(
  WriteInstance,
  makeLokiBinding(makeWriteInstanceClient),
);
