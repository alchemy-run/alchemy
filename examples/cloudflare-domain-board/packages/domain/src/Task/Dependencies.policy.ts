import * as Domain from "@alchemy.run/domain";
import * as Effect from "effect/Effect";
import { Thread } from "../Thread/Thread.aggregate.ts";
import type { ThreadId } from "../Thread/Thread.id.ts";
import { AwaitTask, DependentRegistered } from "./AwaitTask.command.ts";
import { TaskCompleted } from "./CompleteTask.command.ts";
import { TaskCreated } from "./CreateTask.command.ts";
import { MarkDependencyDone } from "./MarkDependencyDone.command.ts";

/**
 * Connects tasks to the tasks they wait for. A new task registers with each
 * dependency; a dependency tells its dependents when it is done, or at once
 * when it already was. Every command it sends records nothing twice, so a
 * redelivered event changes nothing.
 */
export class Dependencies extends Domain.Policy("Dependencies", {
  from: Thread,
  on: [TaskCreated, DependentRegistered, TaskCompleted],
}) {}

export const DependenciesLive = Dependencies.toLayer(
  Effect.gen(function* () {
    const threads = yield* Thread;
    const done = (dependent: ThreadId, dependency: ThreadId) =>
      threads.send(new MarkDependencyDone({ threadId: dependent, dependency }));
    return Effect.fn(function* ({ source, event }) {
      switch (event._tag) {
        case "TaskCreated":
          yield* Effect.forEach(
            event.waitingOn,
            (dependency) =>
              threads.send(new AwaitTask({ threadId: dependency, dependent: source.id })),
            { discard: true },
          );
          return;
        case "DependentRegistered":
          if (event.done) yield* done(event.dependent, source.id);
          return;
        case "TaskCompleted":
          yield* Effect.forEach(event.dependents, (dependent) => done(dependent, source.id), {
            discard: true,
          });
          return;
      }
    });
  }),
);
