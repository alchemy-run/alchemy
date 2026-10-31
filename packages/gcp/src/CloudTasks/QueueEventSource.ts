import * as Binding from "alchemy/Binding";
import * as Effect from "effect/Effect";
import type { Queue } from "./Queue.ts";

/** One task Cloud Tasks dispatched to the host. */
export interface QueueTask {
  /** Task id (the last segment of its name). */
  taskName: string;
  /** Queue id the task came from. */
  queueName: string;
  /** Times this task was retried after a failed attempt. */
  retryCount: number;
  /** Times the task was dispatched, including this attempt. */
  executionCount: number;
  /** When the task was scheduled to run, epoch seconds. */
  eta: string | undefined;
  /** The task's HTTP body. */
  body: Uint8Array;
  /** The task's HTTP headers (lower-cased). */
  headers: Record<string, string>;
}

export interface QueueEventSourceProps {
  /** Delivery path on the host. Defaults to `/__alchemy/cloudtasks/{queue}`. */
  path?: string;
}

export type QueueTaskHandler<Req> = (task: QueueTask) => Effect.Effect<void, never, Req>;

export type QueueEventSourceService = <Req = never>(
  queue: Queue,
  props: QueueEventSourceProps,
  process: QueueTaskHandler<Req>,
) => Effect.Effect<void, never, never>;

/**
 * Event source that makes the hosting compute the worker for a Cloud Tasks
 * {@link Queue}: every task on the queue is dispatched to the host.
 *
 * `GCP.Run.QueueEventSource` binds a queue-level HTTP target onto the
 * queue (it overrides each task's URL and attaches an OIDC token for the
 * host's runtime service account), grants that account `roles/run.invoker`
 * on the host, and verifies the token on every dispatch. A handler that
 * succeeds answers 204 and the task is done; one that fails answers 500
 * and Cloud Tasks retries it under the queue's `retryConfig`.
 *
 * Producers enqueue with `GCP.CloudTasks.CreateTask` / `BufferTask` (any
 * URL: the queue routes to the host).
 *
 * Consume it through {@link consumeQueueTasks}.
 *
 * ### Working a queue
 * **Example:** Process tasks on a Cloud Run service
 * ```typescript
 * const jobs = yield* GCP.CloudTasks.Queue("Jobs", { location: "us-central1" });
 * yield* GCP.CloudTasks.consumeQueueTasks(jobs, (task) =>
 *   Effect.log(`task ${task.taskName}: ${new TextDecoder().decode(task.body)}`),
 * );
 * // …provided with GCP.Run.QueueEventSource
 * ```
 *
 * @binding
 * @category CloudTasks
 */
export interface QueueEventSource extends Binding.Service<
  QueueEventSource,
  "GCP.CloudTasks.QueueEventSource",
  QueueEventSourceService
> {}

export const QueueEventSource = Binding.Service<QueueEventSource>(
  "GCP.CloudTasks.QueueEventSource",
);

/**
 * Run an Effect handler for every task on a Cloud Tasks {@link Queue}.
 * See {@link QueueEventSource}.
 */
export function consumeQueueTasks<Req = never, ResourceReq = never>(
  queue: Queue | Effect.Effect<Queue, never, ResourceReq>,
  process: QueueTaskHandler<Req>,
): Effect.Effect<void, never, QueueEventSource | ResourceReq>;
export function consumeQueueTasks<Req = never, ResourceReq = never>(
  queue: Queue | Effect.Effect<Queue, never, ResourceReq>,
  props: QueueEventSourceProps,
  process: QueueTaskHandler<Req>,
): Effect.Effect<void, never, QueueEventSource | ResourceReq>;
export function consumeQueueTasks<Req = never, ResourceReq = never>(
  queue: Queue | Effect.Effect<Queue, never, ResourceReq>,
  propsOrProcess: QueueEventSourceProps | QueueTaskHandler<Req>,
  maybeProcess?: QueueTaskHandler<Req>,
): Effect.Effect<void, never, QueueEventSource | ResourceReq> {
  const [props, process] =
    typeof propsOrProcess === "function"
      ? [{} as QueueEventSourceProps, propsOrProcess]
      : [propsOrProcess, maybeProcess!];
  const resolved = Effect.isEffect(queue) ? queue : Effect.succeed(queue);
  return resolved.pipe(
    Effect.flatMap((value) => QueueEventSource.use((source) => source(value, props, process))),
  );
}
