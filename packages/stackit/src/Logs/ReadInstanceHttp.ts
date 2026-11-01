import * as Layer from "effect/Layer";
import { makeReadInstanceClient, makeLokiBinding } from "./BindingHttp.ts";
import { ReadInstance } from "./ReadInstance.ts";

/**
 * HTTP implementation of {@link ReadInstance}, on the instance's Grafana Loki API.
 *
 * @layer
 * @provides Stackit.Logs.ReadInstance
 */
export const ReadInstanceHttp = Layer.succeed(
  ReadInstance,
  makeLokiBinding(makeReadInstanceClient),
);
