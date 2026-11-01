import * as loki from "@distilled.cloud/stackit/logs_loki";
import * as Layer from "effect/Layer";
import { makeLogsPushBinding } from "./BindingHttp.ts";
import { PushLogs } from "./PushLogs.ts";

/**
 * HTTP implementation of {@link PushLogs}, on the instance's Loki API.
 *
 * @layer
 * @provides Stackit.Observability.PushLogs
 */
export const PushLogsHttp = Layer.succeed(
  PushLogs,
  makeLogsPushBinding((call) => (request: loki.PushRequest) => call(loki.push, request)),
);
