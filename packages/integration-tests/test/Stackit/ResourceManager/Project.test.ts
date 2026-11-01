import * as Stackit from "@alchemy.run/stackit";
import { expect } from "@alchemy.run/test";
import * as resourceManager from "@distilled.cloud/stackit/resource_manager";
import * as Provider from "alchemy/Provider";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { logLevel, makeStackitTest, stackitEnvironment, stackitTags } from "../helpers.ts";

const { test } = makeStackitTest();

// STACKIT requires at least one *user* among a new project's members, and the
// test profile authenticates as a service account, so the suite needs the
// e-mail of a user in the test organization. The suite only ever deletes
// projects it creates; the profile's project (the sandbox every other suite
// deploys into) is never touched.
const owner = process.env.STACKIT_TEST_PROJECT_OWNER;

const options = {
  tags: stackitTags("resourcemanager", "project"),
  // Project creation and deletion are asynchronous (minutes).
  timeout: 900_000,
} as const;

/** Out-of-band: the project as STACKIT reports it, or `"gone"`. */
const observe = (id: string) =>
  resourceManager
    .getProject({ id })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)));

// The provider already waits until deletion completes; this only absorbs
// read-after-delete lag.
const expectGone = (id: string) =>
  observe(id).pipe(
    Effect.repeat({
      schedule: Schedule.spaced("3 seconds"),
      until: (project) => project === "gone",
      times: 10,
    }),
    Effect.map((project) => expect(project).toEqual("gone")),
  );

const getObserved = (id: string) => resourceManager.getProject({ id });

test.provider.skipIf(!owner)(
  "create, rename, relabel and delete a project",
  (stack) =>
    Effect.gen(function* () {
      const env = yield* stackitEnvironment;
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Stackit.ResourceManager.Project("Sandbox", {
          owner: owner!,
          labels: { env: "test" },
        }),
      );

      expect(created.projectId).not.toEqual(env.projectId);
      expect(created.lifecycleState).toEqual("ACTIVE");
      expect(created.parentType).toEqual("ORGANIZATION");
      expect(created.labels.env).toEqual("test");
      expect(created.name).toMatch(/^[a-zA-Z0-9][a-zA-Z0-9_+&-]{1,40}$/);
      expect(created.networkAreaId).toBeUndefined();

      const fetched = yield* getObserved(created.projectId);
      expect(fetched.name).toEqual(created.name);
      expect(fetched.lifecycleState).toEqual("ACTIVE");
      expect([fetched.parent.containerId, fetched.parent.id]).toContain(env.organizationId);
      expect(fetched.labels?.env).toEqual("test");
      expect(fetched.labels?.["alchemy.id"]).toEqual("Sandbox");
      expect(fetched.labels?.["alchemy.stack"]).toEqual(expect.any(String));

      // nuke sees the project, and never the profile's own project.
      const provider = yield* Provider.findProvider(Stackit.ResourceManager.Project);
      const listed = yield* provider.list();
      expect(listed.map((project) => project.projectId)).toContain(created.projectId);
      expect(listed.map((project) => project.projectId)).not.toContain(env.projectId);

      // Rename + change one label + add another, in place.
      const renamed = `${created.name.slice(0, 33)}-renamed`;
      const updated = yield* stack.deploy(
        Stackit.ResourceManager.Project("Sandbox", {
          name: renamed,
          owner: owner!,
          labels: { env: "prod", team: "platform" },
        }),
      );
      expect(updated.projectId).toEqual(created.projectId);
      expect(updated.name).toEqual(renamed);
      expect(updated.labels).toMatchObject({ env: "prod", team: "platform" });

      const refetched = yield* getObserved(created.projectId);
      expect(refetched.name).toEqual(renamed);
      expect(refetched.labels?.env).toEqual("prod");
      expect(refetched.labels?.team).toEqual("platform");
      expect(refetched.labels?.["alchemy.id"]).toEqual("Sandbox");

      // Removing a user label removes it from the project.
      const trimmed = yield* stack.deploy(
        Stackit.ResourceManager.Project("Sandbox", {
          name: renamed,
          owner: owner!,
          labels: { env: "prod" },
        }),
      );
      expect(trimmed.labels.team).toBeUndefined();
      const afterTrim = yield* getObserved(created.projectId);
      expect(afterTrim.labels?.team).toBeUndefined();
      expect(afterTrim.labels?.env).toEqual("prod");

      // Redeploying unchanged is a no-op.
      const noop = yield* stack.plan(
        Stackit.ResourceManager.Project("Sandbox", {
          name: renamed,
          owner: owner!,
          labels: { env: "prod" },
        }),
      );
      expect(noop.resources.Sandbox).toMatchObject({ action: "noop" });

      yield* stack.destroy();
      yield* expectGone(created.projectId);

      // The profile's project is untouched.
      const sandbox = yield* getObserved(env.projectId);
      expect(sandbox.lifecycleState).toEqual("ACTIVE");
    }).pipe(logLevel),
  options,
);

test.provider.skipIf(!owner)(
  "changing the network area replaces the project and deletes the old one",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      // Both areas stay deployed across the replacement, so no step removes a
      // dependency while replacing its dependant.
      const inArea = (area: "first" | "second") =>
        Effect.gen(function* () {
          const first = yield* Stackit.IaaS.NetworkArea("ProjectAreaFirst", {});
          const second = yield* Stackit.IaaS.NetworkArea("ProjectAreaSecond", {});
          const project = yield* Stackit.ResourceManager.Project("InArea", {
            owner: owner!,
            networkAreaId: area === "first" ? first.networkAreaId : second.networkAreaId,
          });
          return { first, second, project };
        });

      const created = yield* stack.deploy(inArea("first"));
      expect(created.project.networkAreaId).toEqual(created.first.networkAreaId);
      const fetched = yield* getObserved(created.project.projectId);
      expect(fetched.labels?.networkArea).toEqual(created.first.networkAreaId);

      const replaced = yield* stack.deploy(inArea("second"));
      expect(replaced.project.projectId).not.toEqual(created.project.projectId);
      expect(replaced.project.networkAreaId).toEqual(replaced.second.networkAreaId);
      const refetched = yield* getObserved(replaced.project.projectId);
      expect(refetched.lifecycleState).toEqual("ACTIVE");
      expect(refetched.labels?.networkArea).toEqual(replaced.second.networkAreaId);
      yield* expectGone(created.project.projectId);

      yield* stack.destroy();
      yield* expectGone(replaced.project.projectId);
    }).pipe(logLevel),
  // Two project creates and two deletes, each taking minutes.
  { ...options, timeout: 1_800_000 },
);

test.provider.skipIf(!owner)(
  "moves a project into a folder and back without recreating it",
  (stack) =>
    Effect.gen(function* () {
      const env = yield* stackitEnvironment;
      yield* stack.destroy();

      // The folder stays deployed across every step, so no step removes a
      // dependency while changing its dependant.
      const atRoot = yield* stack.deploy(
        Effect.gen(function* () {
          const folder = yield* Stackit.ResourceManager.Folder("Holder", {});
          const project = yield* Stackit.ResourceManager.Project("Mover", { owner: owner! });
          return { folder, project };
        }),
      );
      expect(atRoot.project.parentType).toEqual("ORGANIZATION");

      const inFolder = yield* stack.deploy(
        Effect.gen(function* () {
          const folder = yield* Stackit.ResourceManager.Folder("Holder", {});
          const project = yield* Stackit.ResourceManager.Project("Mover", {
            owner: owner!,
            parentId: folder.containerId,
          });
          return { folder, project };
        }),
      );
      expect(inFolder.project.projectId).toEqual(atRoot.project.projectId);
      expect(inFolder.project.parentType).toEqual("FOLDER");
      expect(inFolder.project.parentId).toEqual(inFolder.folder.containerId);
      const moved = yield* getObserved(atRoot.project.projectId);
      expect(moved.parent.containerId).toEqual(inFolder.folder.containerId);

      const back = yield* stack.deploy(
        Effect.gen(function* () {
          const folder = yield* Stackit.ResourceManager.Folder("Holder", {});
          const project = yield* Stackit.ResourceManager.Project("Mover", { owner: owner! });
          return { folder, project };
        }),
      );
      expect(back.project.projectId).toEqual(atRoot.project.projectId);
      expect(back.project.parentType).toEqual("ORGANIZATION");
      const returned = yield* getObserved(atRoot.project.projectId);
      expect([returned.parent.containerId, returned.parent.id]).toContain(env.organizationId);

      yield* stack.destroy();
      yield* expectGone(atRoot.project.projectId);
      const folder = yield* resourceManager
        .getFolderDetails({ containerId: atRoot.folder.containerId })
        .pipe(Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)));
      expect(folder).toEqual("gone");
    }).pipe(logLevel),
  options,
);
