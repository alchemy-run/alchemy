import * as Layer from "effect/Layer";
import { makeLogsQueryBinding, makeQueryLogsClient } from "./BindingHttp.ts";
import { QueryLogs } from "./QueryLogs.ts";

/**
 * HTTP implementation of {@link QueryLogs}, on the instance's Loki API.
 *
 * @layer
 * @provides Stackit.Observability.QueryLogs
 */
export const QueryLogsHttp = Layer.succeed(QueryLogs, makeLogsQueryBinding(makeQueryLogsClient));
