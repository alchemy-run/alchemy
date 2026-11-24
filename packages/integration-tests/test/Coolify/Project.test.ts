import * as Coolify from "@alchemy.run/coolify";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as CoolifyApi from "@distilled.cloud/coolify";
import * as Provider from "alchemy/Provider";
import * as Effect from "effect/Effect";
import { hasToken, projectGone } from "./helpers.ts";

const { test } = Test.make({ providers: Coolify.providers() });

test.provider.skipIf(!hasToken)(
  "create, rename and delete a project",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Coolify.Project("App", { description: "first" });
        }),
      );
      expect(created.projectUuid).toEqual(expect.any(String));
      expect(created.description).toEqual("first");

      const fetched = yield* CoolifyApi.getProject({ uuid: created.projectUuid });
      expect(fetched.name).toEqual(created.name);
      expect(fetched.description).toEqual("first");

      // Coolify creates a production environment with every project.
      const production = yield* CoolifyApi.getEnvironmentByNameOrUuid({
        uuid: created.projectUuid,
        environment_name_or_uuid: "production",
      });
      expect(production.name).toEqual("production");

      const provider = yield* Provider.findProvider(Coolify.Project);
      const listed = yield* provider.list();
      expect(listed.map((p) => p.projectUuid)).toContain(created.projectUuid);

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Coolify.Project("App", {
            name: `${created.name}-renamed`,
            description: "second",
          });
        }),
      );
      expect(updated.projectUuid).toEqual(created.projectUuid);
      expect(updated.name).toEqual(`${created.name}-renamed`);

      const refetched = yield* CoolifyApi.getProject({ uuid: created.projectUuid });
      expect(refetched.name).toEqual(`${created.name}-renamed`);
      expect(refetched.description).toEqual("second");

      yield* stack.destroy();
      expect(yield* projectGone(created.projectUuid)).toEqual("gone");
    }),
  { tags: ["provider:coolify", "provider:coolify:project", "live"], timeout: 120_000 },
);

test.provider.skipIf(!hasToken)(
  "recreates a project deleted out of band",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const program = Effect.gen(function* () {
        return yield* Coolify.Project("Drift", {});
      });
      const first = yield* stack.deploy(program);
      yield* CoolifyApi.deleteProject({ uuid: first.projectUuid });

      const second = yield* stack.deploy(program);
      expect(second.projectUuid).not.toEqual(first.projectUuid);
      expect((yield* CoolifyApi.getProject({ uuid: second.projectUuid })).name).toEqual(
        second.name,
      );

      yield* stack.destroy();
      expect(yield* projectGone(second.projectUuid)).toEqual("gone");
    }),
  { tags: ["provider:coolify", "provider:coolify:project", "live"], timeout: 120_000 },
);
