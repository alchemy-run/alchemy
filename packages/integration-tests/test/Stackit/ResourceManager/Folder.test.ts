import * as Stackit from "@alchemy.run/stackit";
import { expect } from "@alchemy.run/test";
import * as resourceManager from "@distilled.cloud/stackit/resource_manager";
import * as Provider from "alchemy/Provider";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { logLevel, makeStackitTest, stackitEnvironment, stackitTags } from "../helpers.ts";

const { test } = makeStackitTest();

// Folders are free and need only organization-level Resource Manager
// permissions for the test service account, so the suite is ungated.
const options = {
  tags: stackitTags("resourcemanager", "folder"),
  timeout: 300_000,
} as const;

/** Out-of-band: the folder as STACKIT reports it, or `"gone"`. */
const observe = (containerId: string) =>
  resourceManager
    .getFolderDetails({ containerId })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)));

// The provider already waits until deletion completes; this only absorbs
// read-after-delete lag.
const expectGone = (containerId: string) =>
  observe(containerId).pipe(
    Effect.repeat({
      schedule: Schedule.spaced("2 seconds"),
      until: (folder) => folder === "gone",
      times: 10,
    }),
    Effect.map((folder) => expect(folder).toEqual("gone")),
  );

test.provider(
  "create, rename, relabel and delete a folder",
  (stack) =>
    Effect.gen(function* () {
      const env = yield* stackitEnvironment;
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Stackit.ResourceManager.Folder("Team", { labels: { env: "test" } }),
      );

      expect(created.folderId).toEqual(expect.any(String));
      expect(created.containerId).toEqual(expect.any(String));
      expect(created.parentType).toEqual("ORGANIZATION");
      expect(created.labels.env).toEqual("test");
      expect(created.name).toMatch(/^[a-zA-Z0-9][a-zA-Z0-9_+&-]{1,40}$/);

      const fetched = yield* resourceManager.getFolderDetails({
        containerId: created.containerId,
      });
      expect(fetched.folderId).toEqual(created.folderId);
      expect(fetched.name).toEqual(created.name);
      expect([fetched.parent.containerId, fetched.parent.id]).toContain(env.organizationId);
      expect(fetched.labels?.env).toEqual("test");
      expect(fetched.labels?.["alchemy.id"]).toEqual("Team");

      const provider = yield* Provider.findProvider(Stackit.ResourceManager.Folder);
      const listed = yield* provider.list();
      expect(listed.map((folder) => folder.containerId)).toContain(created.containerId);

      // Rename + change one label + add another, in place.
      const renamed = `${created.name.slice(0, 33)}-renamed`;
      const updated = yield* stack.deploy(
        Stackit.ResourceManager.Folder("Team", {
          name: renamed,
          labels: { env: "prod", team: "platform" },
        }),
      );
      expect(updated.folderId).toEqual(created.folderId);
      expect(updated.name).toEqual(renamed);
      expect(updated.labels).toMatchObject({ env: "prod", team: "platform" });

      const refetched = yield* resourceManager.getFolderDetails({
        containerId: created.containerId,
      });
      expect(refetched.name).toEqual(renamed);
      expect(refetched.labels?.env).toEqual("prod");
      expect(refetched.labels?.team).toEqual("platform");

      // Removing a user label removes it from the folder.
      yield* stack.deploy(
        Stackit.ResourceManager.Folder("Team", { name: renamed, labels: { env: "prod" } }),
      );
      const trimmed = yield* resourceManager.getFolderDetails({
        containerId: created.containerId,
      });
      expect(trimmed.labels?.team).toBeUndefined();
      expect(trimmed.labels?.env).toEqual("prod");
      expect(trimmed.labels?.["alchemy.id"]).toEqual("Team");

      // Redeploying unchanged is a no-op.
      const noop = yield* stack.plan(
        Stackit.ResourceManager.Folder("Team", { name: renamed, labels: { env: "prod" } }),
      );
      expect(noop.resources.Team).toMatchObject({ action: "noop" });

      yield* stack.destroy();
      yield* expectGone(created.containerId);
    }).pipe(logLevel),
  options,
);

test.provider(
  "nests a folder and moves it back to the organization",
  (stack) =>
    Effect.gen(function* () {
      const env = yield* stackitEnvironment;
      yield* stack.destroy();

      const nested = yield* stack.deploy(
        Effect.gen(function* () {
          const parent = yield* Stackit.ResourceManager.Folder("Parent", {});
          const child = yield* Stackit.ResourceManager.Folder("Child", {
            parentId: parent.containerId,
          });
          return { parent, child };
        }),
      );
      expect(nested.child.parentType).toEqual("FOLDER");
      expect(nested.child.parentId).toEqual(nested.parent.containerId);
      const inParent = yield* resourceManager.getFolderDetails({
        containerId: nested.child.containerId,
      });
      expect(inParent.parent.containerId).toEqual(nested.parent.containerId);

      // Move the child to the organization; the parent stays deployed.
      const moved = yield* stack.deploy(
        Effect.gen(function* () {
          const parent = yield* Stackit.ResourceManager.Folder("Parent", {});
          const child = yield* Stackit.ResourceManager.Folder("Child", {});
          return { parent, child };
        }),
      );
      expect(moved.child.folderId).toEqual(nested.child.folderId);
      expect(moved.child.parentType).toEqual("ORGANIZATION");
      const atRoot = yield* resourceManager.getFolderDetails({
        containerId: nested.child.containerId,
      });
      expect([atRoot.parent.containerId, atRoot.parent.id]).toContain(env.organizationId);

      // Destroying a nested hierarchy deletes the child before the parent.
      yield* stack.deploy(
        Effect.gen(function* () {
          const parent = yield* Stackit.ResourceManager.Folder("Parent", {});
          const child = yield* Stackit.ResourceManager.Folder("Child", {
            parentId: parent.containerId,
          });
          return { parent, child };
        }),
      );
      yield* stack.destroy();
      yield* expectGone(nested.child.containerId);
      yield* expectGone(nested.parent.containerId);
    }).pipe(logLevel),
  options,
);
