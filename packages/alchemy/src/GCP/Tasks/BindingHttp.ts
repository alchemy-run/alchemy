import { Credentials } from "@distilled.cloud/gcp/Credentials";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/unstable/http/HttpClient";
import type { Task } from "./Task.ts";
import type { Tasklist } from "./Tasklist.ts";

type GcpHttpOp<I, A, E> = Effect.Effect<
  (input: I) => Effect.Effect<A, E>,
  never,
  Credentials | HttpClient.HttpClient
> &
  ((input: I) => Effect.Effect<A, E, Credentials | HttpClient.HttpClient>);

/**
 * Shared HTTP scaffolding for Tasks task-list bindings.
 * NOT exported from index.ts.
 */
export const makeTasklistHttpBinding = <
  I extends { tasklist: string },
  A,
  E,
>(options: {
  tag: string;
  operation: GcpHttpOp<I, A, E>;
}) =>
  Effect.gen(function* () {
    const run = yield* options.operation;
    return Effect.fn(function* (list: Tasklist) {
      const tasklistId = yield* list.tasklistId;
      return Effect.fn(`${options.tag}(${list.LogicalId})`)(function* (
        request: Omit<I, "tasklist">,
      ) {
        return yield* run({
          ...request,
          tasklist: yield* tasklistId,
        } as I);
      });
    });
  });

/**
 * Shared HTTP scaffolding for Tasks task bindings.
 * NOT exported from index.ts.
 */
export const makeTaskHttpBinding = <
  I extends { tasklist: string; task: string },
  A,
  E,
>(options: {
  tag: string;
  operation: GcpHttpOp<I, A, E>;
}) =>
  Effect.gen(function* () {
    const run = yield* options.operation;
    return Effect.fn(function* (task: Task) {
      const tasklistId = yield* task.tasklistId;
      const taskId = yield* task.taskId;
      return Effect.fn(`${options.tag}(${task.LogicalId})`)(function* (
        request: Omit<I, "tasklist" | "task">,
      ) {
        return yield* run({
          ...request,
          tasklist: yield* tasklistId,
          task: yield* taskId,
        } as I);
      });
    });
  });
