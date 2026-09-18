import * as Cloudflare from "@/Cloudflare/index.ts";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

export class Journal extends Cloudflare.DurableObject<Journal>()(
  "LifecycleJournal",
  Effect.gen(function* () {
    const state = yield* Cloudflare.DurableObjectState;
    return Effect.succeed({
      record: Effect.fn(function* (entry: string) {
        const entries = (yield* state.storage.get<string[]>("entries")) ?? [];
        yield* state.storage.put("entries", [...entries, entry]);
      }),
      entries: () => state.storage.get<string[]>("entries"),
    });
  }),
) {}

class Dependency extends Context.Service<Dependency, string>()(
  "LifecycleDependency",
) {}

export type Scenario = "success" | "retry" | "interrupt" | "rollback";

export class LifecycleWorkflow extends Cloudflare.Workflow<LifecycleWorkflow>()(
  "LifecycleWorkflow",
  Effect.gen(function* () {
    const journals = yield* Journal;
    return Effect.fn(function* (input: { scenario: Scenario }) {
      const event = yield* Cloudflare.Workflows.WorkflowEvent;
      const journal = journals.getByName(event.instanceId);
      const runScope = yield* Effect.scope;
      const started = yield* Deferred.make<void>();

      const attempt = Effect.gen(function* () {
        const context = yield* Cloudflare.Workflows.WorkflowStepContext;
        const scope = yield* Effect.scope;
        const dependency = yield* Dependency;
        yield* Effect.addFinalizer(() =>
          Effect.sleep("20 millis").pipe(
            Effect.andThen(journal.record(`close:${context.attempt}`)),
            Effect.orDie,
          ),
        );
        yield* journal.record(
          `open:${context.attempt}:${dependency}:${scope !== runScope}`,
        );
        yield* Deferred.succeed(started, undefined);
        if (input.scenario === "interrupt") return yield* Effect.never;
        if (input.scenario === "retry" && context.attempt === 1) {
          return yield* Effect.die(new Error("retry this attempt"));
        }
        return "saved";
      });

      const task = Cloudflare.Workflows.task("attempt", attempt, {
        retries: { limit: 1, delay: "1 second", backoff: "constant" },
        timeout: "10 seconds",
        ...(input.scenario === "rollback"
          ? {
              rollback: Effect.fn(function* () {
                const scope = yield* Effect.scope;
                const dependency = yield* Dependency;
                yield* Effect.addFinalizer(() =>
                  Effect.sleep("20 millis").pipe(
                    Effect.andThen(journal.record("rollback-close")),
                    Effect.orDie,
                  ),
                );
                yield* journal.record(
                  `rollback-open:${dependency}:${scope !== runScope}`,
                );
                yield* journal.record("rollback-body");
              }),
              rollbackConfig: { retries: { limit: 0, delay: "1 second" } },
            }
          : {}),
      }).pipe(Effect.provideService(Dependency, "captured"));

      if (input.scenario === "interrupt") {
        const fiber = yield* Effect.forkChild(task);
        yield* Deferred.await(started);
        yield* Fiber.interrupt(fiber);
        yield* journal.record("joined");
        yield* Effect.sleep("2500 millis");
      } else {
        yield* task;
      }
      yield* journal.record("after-task");
      if (input.scenario === "rollback") {
        return yield* Effect.die(new Error("trigger compensation"));
      }
      return yield* journal.entries();
    });
  }),
) {}

export default class LifecycleWorker extends Cloudflare.Worker<LifecycleWorker>()(
  "LifecycleWorker",
  { main: import.meta.url },
  Effect.gen(function* () {
    const workflow = yield* LifecycleWorkflow;
    const journals = yield* Journal;
    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const path = new URL(request.url, "http://localhost").pathname;
        const [, action, value] = path.split("/");
        if (action === "start" && request.method === "POST") {
          const instance = yield* workflow.create({
            params: { scenario: value as Scenario },
          });
          return yield* HttpServerResponse.json({ id: instance.id });
        }
        if (action === "journal") {
          return yield* HttpServerResponse.json(
            (yield* journals.getByName(value).entries()) ?? [],
          );
        }
        if (action === "status") {
          const instance = yield* workflow.get(value);
          return yield* HttpServerResponse.json({
            ...(yield* instance.status()),
            entries: (yield* journals.getByName(value).entries()) ?? [],
          });
        }
        yield* journals.getByName("ready").entries();
        return HttpServerResponse.text("ready");
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.succeed(
            HttpServerResponse.text(Cause.pretty(cause), { status: 500 }),
          ),
        ),
      ),
    };
  }),
) {}
