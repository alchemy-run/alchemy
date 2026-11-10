import * as flash from "@distilled.cloud/modal/flash";
import * as server from "@distilled.cloud/modal/server";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { makeFunctionBinding } from "./FunctionTarget.ts";
import { operations, timestampOf } from "./internal.ts";
import { ReadServer, type ServerReader } from "./ReadServer.ts";
import type { Server } from "./Server.ts";

/** The operations the client calls, resolved by `ModalBindings.withCredentials`. */
const ReadServerOps = operations({
  stats: server.serverGetTimeRangeStats,
  requests: server.fetchServerRequest,
  requestCount: server.serverCountRequests,
  metrics: server.serverGetMetrics,
  containers: flash.listFlashContainer,
});

export type ReadServerOps = Effect.Success<typeof ReadServerOps>;

/**
 * {@link ReadServer} over Modal's API. Grants the host's identity (a scoped
 * `Modal.ServiceUser`) the `viewer` role on the server's environment.
 *
 * @layer
 * @product Server
 * @provides Modal.ReadServer
 */
export const ReadServerHttp = Layer.effect(
  ReadServer,
  makeFunctionBinding({
    tag: "Modal.ReadServer",
    operations: ReadServerOps,
    role: "viewer",
    make: ({ functionId }, ops, _server: Server) =>
      Effect.succeed({
        stats: (range) =>
          Effect.flatMap(functionId, (id) =>
            ops.stats({
              functionId: id,
              since: timestampOf(range.since),
              until: timestampOf(range.until ?? Date.now()),
              containerId: range.containerId,
            }),
          ),
        requests: (query) =>
          Effect.flatMap(functionId, (id) =>
            ops.requests(
              "limit" in query
                ? { functionId: id, tail: { count: query.limit } }
                : {
                    functionId: id,
                    range: {
                      since: timestampOf(query.since),
                      until: timestampOf(query.until ?? Date.now()),
                    },
                  },
            ),
          ).pipe(
            Effect.map((response) =>
              (response.requests ?? []).map((request) => ({
                route: request.route,
                timestamp: request.timestamp,
                containerId: request.containerId,
                durationSeconds: request.durationSeconds,
                status: request.status,
              })),
            ),
          ),
        requestCount: (range) =>
          Effect.flatMap(functionId, (id) =>
            ops.requestCount({
              functionId: id,
              since: timestampOf(range.since),
              until: timestampOf(range.until ?? Date.now()),
              bucketSecs: range.bucketSecs,
            }),
          ),
        metrics: (range) =>
          Effect.flatMap(functionId, (id) =>
            ops.metrics({
              functionId: id,
              since: timestampOf(range.since),
              until: timestampOf(range.until ?? Date.now()),
              bucketSecs: range.bucketSecs,
              groups: range.groups ? [...range.groups] : undefined,
            }),
          ),
        containers: () =>
          Effect.flatMap(functionId, (id) => ops.containers({ functionId: id })).pipe(
            Effect.map((response) =>
              (response.containers ?? []).map((container) => ({
                containerId: container.taskId ?? "",
                host: container.host,
                port: container.port,
              })),
            ),
          ),
      } satisfies ServerReader),
  }),
);
