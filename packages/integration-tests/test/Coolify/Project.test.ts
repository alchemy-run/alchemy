import * as Coolify from "@alchemy.run/coolify";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as CoolifyApi from "@distilled.cloud/coolify";
import * as Provider from "alchemy/Provider";
import * as Effect from "effect/Effect";
import {
  canCreateProjects,
  environmentGone,
  hasProject,
  projectGone,
  testProject,
} from "./helpers.ts";

const { test } = Test.make({ providers: Coolify.providers() });

const tags = ["provider:coolify", "provider:coolify:project", "live"];

// A project-scoped token can't create projects or use team-wide endpoints;
// both come back as typed 403s.
test.provider.skipIf(!hasProject || canCreateProjects)(
  "a project-scoped token gets typed 403s",
  () =>
    Effect.gen(function* () {
      const create = yield* CoolifyApi.createProject({ name: "alchemy-scope-probe" }).pipe(
        Effect.flip,
      );
      expect(create._tag).toEqual("ActionNotAuthorized");
      const servers = yield* CoolifyApi.listServers({}).pipe(Effect.flip);
      expect(servers._tag).toEqual("TokenScopeForbidden");
    }),
  { tags, timeout: 60_000 },
);

test.provider.skipIf(!hasProject)(
  "look up a project the stack doesn't manage",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const projectUuid = yield* testProject;

      // The looked-up project feeds a managed environment, so the lookup
      // resolves during the deploy like any other dependency.
      const deployed = yield* stack.deploy(
        Effect.gen(function* () {
          const project = Coolify.Project.lookup({ projectUuid });
          return yield* Coolify.Environment("InLookedUpProject", {
            project: project.projectUuid,
          });
        }),
      );
      expect(deployed.projectUuid).toEqual(projectUuid);

      // Destroying the stack deletes the environment, never the project.
      yield* stack.destroy();
      expect(yield* environmentGone(projectUuid, deployed.environmentUuid)).toEqual("gone");
      expect((yield* CoolifyApi.getProject({ uuid: projectUuid })).uuid).toEqual(projectUuid);
    }),
  { tags, timeout: 60_000 },
);

test.provider.skipIf(!canCreateProjects)(
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

      const refetched = yield* CoolifyApi.getProject({ uuid: created.projectUuid });
      expect(refetched.name).toEqual(`${created.name}-renamed`);
      expect(refetched.description).toEqual("second");

      yield* stack.destroy();
      expect(yield* projectGone(created.projectUuid)).toEqual("gone");
    }),
  { tags, timeout: 120_000 },
);

test.provider.skipIf(!canCreateProjects)(
  "recreates a project deleted out of band",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const program = (description: string) =>
        Effect.gen(function* () {
          return yield* Coolify.Project("Drift", { description });
        });
      const first = yield* stack.deploy(program("first"));
      yield* CoolifyApi.deleteProject({ uuid: first.projectUuid });

      const second = yield* stack.deploy(program("second"));
      expect(second.projectUuid).not.toEqual(first.projectUuid);

      yield* stack.destroy();
      expect(yield* projectGone(second.projectUuid)).toEqual("gone");
    }),
  { tags, timeout: 120_000 },
);
