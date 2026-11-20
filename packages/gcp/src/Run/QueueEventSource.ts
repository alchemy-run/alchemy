import * as Namespace from "alchemy/Namespace";
import * as Output from "alchemy/Output";
import * as Effect from "effect/Effect";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Layer from "effect/Layer";
import { QUEUE_EVENT_PATH_PREFIX, type Queue } from "../CloudTasks/Queue.ts";
import {
  QueueEventSource as CloudTasksQueueEventSource,
  type QueueEventSourceProps,
  type QueueEventSourceService,
  type QueueTaskHandler,
} from "../CloudTasks/QueueEventSource.ts";
import {
  deliveryAudience,
  grantSelfInvoker,
  hostEndpoint,
  listenForDeliveries,
  pathSegment,
  pushHost,
} from "../PushDelivery.ts";

/**
 * HTTP implementation of `GCP.CloudTasks.QueueEventSource` for
 * `GCP.Run.Service` / `GCP.Function` and `GCP.CloudFunctions.Function`.
 *
 * Deploy-time: binds a queue-level HTTP target onto the queue that sends
 * every task to `{host}{path}` as a `POST` with an OIDC token for the
 * host's runtime service account, and grants that account
 * `roles/run.invoker` on the host. Runtime: claims dispatches on the path,
 * verifies the token, and runs the handler; 204 completes the task, a
 * failed handler answers 500 and Cloud Tasks retries.
 *
 * @layer
 * @provides GCP.CloudTasks.QueueEventSource
 * @category Run
 */
export const QueueEventSource = Layer.succeed(
  CloudTasksQueueEventSource,
  Effect.fn(function* <Req = never>(
    queue: Queue,
    props: QueueEventSourceProps,
    handler: QueueTaskHandler<Req>,
  ) {
    const host = yield* pushHost("GCP.CloudTasks.QueueEventSource");
    const path = props.path ?? `${QUEUE_EVENT_PATH_PREFIX}${pathSegment(queue.LogicalId)}`;

    if (!globalThis.__ALCHEMY_RUNTIME__) {
      const endpoint = hostEndpoint(host);
      yield* Namespace.push(host.LogicalId, grantSelfInvoker(host));
      yield* queue.bind`GCP.CloudTasks.QueueEventSource(${host}, ${queue})`({
        httpTarget: {
          httpMethod: "POST",
          uriOverride: {
            scheme: "HTTPS",
            host: Output.map(endpoint.url, (url) => new URL(url).host),
            pathOverride: { path },
            uriOverrideEnforceMode: "ALWAYS",
          },
          oidcToken: {
            serviceAccountEmail: endpoint.serviceAccount,
            audience: deliveryAudience(endpoint.url, path),
          },
        },
      });
    }

    yield* listenForDeliveries(host, path, (request) =>
      Effect.gen(function* () {
        const body = yield* request.arrayBuffer.pipe(
          Effect.map((buffer) => new Uint8Array(buffer)),
          Effect.orElseSucceed(() => new Uint8Array()),
        );
        const headers = request.headers as Record<string, string>;
        yield* handler({
          taskName: headers["x-cloudtasks-taskname"] ?? "",
          queueName: headers["x-cloudtasks-queuename"] ?? "",
          retryCount: Number(headers["x-cloudtasks-taskretrycount"] ?? 0),
          executionCount: Number(headers["x-cloudtasks-taskexecutioncount"] ?? 0),
          eta: headers["x-cloudtasks-tasketa"],
          body,
          headers,
        }).pipe(Effect.orDie);
        return HttpServerResponse.empty({ status: 204 });
      }),
    );
  }) as QueueEventSourceService,
);
