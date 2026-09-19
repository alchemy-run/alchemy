import * as Cloudflare from "alchemy/Cloudflare";
import * as TypeSafe from "alchemy/TypeSafe";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { Posts } from "../chat/Posts.ts";
import { inWorker } from "../platform/Database.ts";
import { Desks } from "./Desks.ts";
import { routeTask } from "./Router.ts";
import { mintTaskId, Tasks, type TaskRow } from "./TasksDO.ts";

/**
 * FILING — the one door every intake takes (the API's "New task",
 * Triage's singles, an agent's explicit filing): route the task to a
 * queue (Router.ts — the rubrics are the queues' own missions),
 * create its conversation thread (a root post in the `tasks:<queue>`
 * channel), insert the board row, and pump the queue's desks in the
 * background (`ctx.waitUntil`) — filing never waits on a desk round.
 *
 * An unsure route files to the FIRST registered queue's INBOX — the
 * human routes it from the board; a confident route (or an explicit
 * `queue`) files READY.
 */
export interface FileTaskInput {
  readonly title: string;
  readonly body: string;
  /** Explicit queue slug — skips the router. */
  readonly queue?: string;
  readonly origin?: string;
  readonly priority?: number;
  readonly actor: string;
}

export class TaskIntake extends Context.Service<
  TaskIntake,
  {
    /** File one task; `undefined` when no queue is registered. */
    readonly file: (
      input: FileTaskInput,
    ) => Effect.Effect<TaskRow | undefined>;
  }
>()("root/TaskIntake") {}

export const TaskIntakeLive: Layer.Layer<
  TaskIntake,
  never,
  Tasks | Desks | Posts | TypeSafe.SystemOne | Cloudflare.WorkerExecutionContext
> = Layer.effect(
  TaskIntake,
  Effect.gen(function* () {
    const tasks = yield* Tasks;
    const desks = yield* Desks;
    const posts = yield* Posts;
    const query = yield* TypeSafe.SystemOne;
    const exec = yield* Cloudflare.WorkerExecutionContext;

    const clip = (value: string, at: number) =>
      value.length > at ? `${value.slice(0, at)}…` : value;

    return TaskIntake.of({
      file: (input) =>
        Effect.gen(function* () {
          const queues = desks.queues();
          if (queues.length === 0) return undefined;
          const explicit = queues.find(
            (queue) => queue.slug === input.queue,
          )?.slug;
          const routed =
            explicit ??
            (yield* routeTask(
              query,
              {
                title: input.title,
                body: input.body,
                ...(input.origin === undefined ? {} : { origin: input.origin }),
              },
              queues,
            ).pipe(inWorker));
          const target = routed ?? queues[0]!.slug;
          const state = routed === undefined ? "inbox" : "ready";
          const id = yield* mintTaskId;
          // the task's conversation: a thread root in the queue's
          // channel — timeline comments and workspace pills come free
          // from the chat machinery
          const minted = yield* Clock.currentTimeMillis;
          const rootPost = `p-${minted.toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
          yield* posts.post({
            id: rootPost,
            channel: `tasks:${target}`,
            author: input.actor,
            text: `${input.title}\n\n${clip(input.body, 2_000)}`,
            status: "settled",
            mode: "thread",
          });
          const task = yield* tasks.file(target, {
            id,
            queue: target,
            title: input.title,
            body: input.body,
            state,
            rootPost,
            actor: input.actor,
            ...(input.origin === undefined ? {} : { origin: input.origin }),
            ...(input.priority === undefined
              ? {}
              : { priority: input.priority }),
          });
          // pump AFTER the response (TasksApi's re-arm pattern): a
          // desk round can run minutes — filing returns immediately
          // and the pump rides `ctx.waitUntil`
          yield* exec.waitUntil(desks.pump(target)).pipe(inWorker);
          return task;
        }),
    });
  }),
);
