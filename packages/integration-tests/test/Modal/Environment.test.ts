import * as Modal from "@alchemy.run/modal";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as environment from "@distilled.cloud/modal/environment";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { expectFound } from "./lookup.ts";

const { test } = Test.make({ providers: Modal.providers() });

const listed = (name: string) =>
  environment
    .listEnvironment({})
    .pipe(Effect.map(({ items }) => (items ?? []).find((item) => item.name === name)));

test.provider(
  "create, rename, set limits, and delete an environment",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const env = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Modal.Environment("Env", { maxConcurrentTasks: 10 });
        }),
      );
      yield* expectFound(Modal.Environment.lookup({ name: env.name }), env);
      expect(env.environmentId).toMatch(/^en-/);
      const observed = yield* listed(env.name);
      expect(observed?.environmentId).toBe(env.environmentId);
      expect(observed?.maxConcurrentTasks).toBe(10);

      const renamedTo = `${env.name.slice(0, 55)}-renamed`;
      const renamed = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Modal.Environment("Env", { name: renamedTo, maxConcurrentTasks: 5 });
        }),
      );
      expect(renamed.environmentId).toBe(env.environmentId);
      expect(renamed.name).toBe(renamedTo);
      expect((yield* listed(renamedTo))?.maxConcurrentTasks).toBe(5);
      expect(yield* listed(env.name)).toBeUndefined();

      yield* stack.destroy();
      const gone = yield* listed(renamedTo).pipe(
        Effect.repeat({
          schedule: Schedule.spaced("1 second"),
          until: (item) => item === undefined,
          times: 10,
        }),
      );
      expect(gone).toBeUndefined();
    }),
  { tags: ["provider:modal", "provider:modal:environment", "live"], timeout: 120_000 },
);
