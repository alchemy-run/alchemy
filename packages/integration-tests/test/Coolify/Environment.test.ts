import * as Coolify from "@alchemy.run/coolify";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as CoolifyApi from "@distilled.cloud/coolify";
import * as Effect from "effect/Effect";
import { environmentGone, hasToken, projectGone } from "./helpers.ts";

const { test } = Test.make({ providers: Coolify.providers() });

test.provider.skipIf(!hasToken)(
  "create, rename, replace and delete an environment",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const project = yield* Coolify.Project("EnvProject", {});
          const environment = yield* Coolify.Environment("Staging", {
            project: project.projectUuid,
            name: "staging",
          });
          return { project, environment };
        }),
      );
      expect(created.environment.projectUuid).toEqual(created.project.projectUuid);
      expect(created.environment.name).toEqual("staging");

      const fetched = yield* CoolifyApi.getEnvironmentByNameOrUuid({
        uuid: created.project.projectUuid,
        environment_name_or_uuid: created.environment.environmentUuid,
      });
      expect(fetched.name).toEqual("staging");

      // Rename and describe in place.
      const renamed = yield* stack.deploy(
        Effect.gen(function* () {
          const project = yield* Coolify.Project("EnvProject", {});
          const environment = yield* Coolify.Environment("Staging", {
            project: project.projectUuid,
            name: "qa",
            description: "quality",
          });
          return { project, environment };
        }),
      );
      expect(renamed.environment.environmentUuid).toEqual(created.environment.environmentUuid);
      const refetched = yield* CoolifyApi.getEnvironmentByNameOrUuid({
        uuid: created.project.projectUuid,
        environment_name_or_uuid: created.environment.environmentUuid,
      });
      expect(refetched.name).toEqual("qa");
      expect(refetched.description).toEqual("quality");

      // Moving to another project replaces it; both projects stay deployed
      // across the replacement.
      const moved = yield* stack.deploy(
        Effect.gen(function* () {
          const project = yield* Coolify.Project("EnvProject", {});
          const other = yield* Coolify.Project("EnvProject2", {});
          const environment = yield* Coolify.Environment("Staging", {
            project: other.projectUuid,
            name: "qa",
          });
          return { project, other, environment };
        }),
      );
      expect(moved.environment.projectUuid).toEqual(moved.other.projectUuid);
      expect(moved.environment.environmentUuid).not.toEqual(created.environment.environmentUuid);
      expect(
        yield* environmentGone(created.project.projectUuid, created.environment.environmentUuid),
      ).toEqual("gone");

      yield* stack.destroy();
      expect(yield* projectGone(moved.project.projectUuid)).toEqual("gone");
      expect(yield* projectGone(moved.other.projectUuid)).toEqual("gone");
    }),
  { tags: ["provider:coolify", "provider:coolify:environment", "live"], timeout: 120_000 },
);
