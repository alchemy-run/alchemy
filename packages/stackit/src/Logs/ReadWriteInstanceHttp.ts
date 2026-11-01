import * as Layer from "effect/Layer";
import { makeReadWriteInstanceClient, makeLokiBinding } from "./BindingHttp.ts";
import { ReadWriteInstance } from "./ReadWriteInstance.ts";

/**
 * HTTP implementation of {@link ReadWriteInstance}, on the instance's Grafana Loki API.
 *
 * @layer
 * @provides Stackit.Logs.ReadWriteInstance
 */
export const ReadWriteInstanceHttp = Layer.succeed(
  ReadWriteInstance,
  makeLokiBinding(makeReadWriteInstanceClient),
);
