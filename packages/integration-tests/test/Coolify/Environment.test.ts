import * as Coolify from "@alchemy.run/coolify";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as CoolifyApi from "@distilled.cloud/coolify";
import * as Effect from "effect/Effect";
import { environmentGone, hasProject, testProject } from "./helpers.ts";

const { test } = Test.make({ providers: Coolify.providers() });

const tags = ["provider:coolify", "provider:coolify:environment", "live"];

test.provider.skipIf(!hasProject)(
  "create, rename and delete an environment",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const project = yield* testProject;

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Coolify.Environment("Staging", { project });
        }),
      );
      expect(created.projectUuid).toEqual(project);

      const fetched = yield* CoolifyApi.getEnvironmentByNameOrUuid({
        uuid: project,
        environment_name_or_uuid: created.environmentUuid,
      });
      expect(fetched.name).toEqual(created.name);

      // Rename and describe in place.
      const renamed = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Coolify.Environment("Staging", {
            project,
            name: `${created.name}-qa`,
            description: "quality",
          });
        }),
      );
      expect(renamed.environmentUuid).toEqual(created.environmentUuid);
      const refetched = yield* CoolifyApi.getEnvironmentByNameOrUuid({
        uuid: project,
        environment_name_or_uuid: created.environmentUuid,
      });
      expect(refetched.name).toEqual(`${created.name}-qa`);
      expect(refetched.description).toEqual("quality");

      yield* stack.destroy();
      expect(yield* environmentGone(project, created.environmentUuid)).toEqual("gone");
    }),
  { tags, timeout: 120_000 },
);

test.provider.skipIf(!hasProject)(
  "recreates an environment deleted out of band",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const project = yield* testProject;

      const program = (description: string) =>
        Effect.gen(function* () {
          return yield* Coolify.Environment("Drift", { project, description });
        });
      const first = yield* stack.deploy(program("first"));
      yield* CoolifyApi.deleteEnvironment({
        uuid: project,
        environment_name_or_uuid: first.environmentUuid,
      });

      // An unchanged deploy plans a noop; a change runs reconcile, which
      // treats the uuid in state as a cache and recreates what's missing.
      const second = yield* stack.deploy(program("second"));
      expect(second.environmentUuid).not.toEqual(first.environmentUuid);
      expect(second.name).toEqual(first.name);

      yield* stack.destroy();
      expect(yield* environmentGone(project, second.environmentUuid)).toEqual("gone");
    }),
  { tags, timeout: 120_000 },
);
