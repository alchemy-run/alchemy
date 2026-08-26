import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as resourcemanager from "@distilled.cloud/gcp/cloudresourcemanager_v3";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: GCP.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const hasGcpCreds = !!(
  process.env.GOOGLE_PROJECT_ID &&
  (process.env.GOOGLE_ACCESS_TOKEN ||
    process.env.GOOGLE_APPLICATION_CREDENTIALS)
);

const project = process.env.GOOGLE_PROJECT_ID ?? "alchemy-gcp-testing-83661";
// Live create returns Forbidden: "The caller does not have permission"
// (resourcemanager.projects.create on the parent organization/folder).
const runLifecycle =
  hasGcpCreds &&
  !process.env.FAST &&
  process.env.GCP_TEST_RESOURCE_MANAGER === "1";

const waitUntilGone = (name: string) =>
  resourcemanager.getProjects({ name }).pipe(
    Effect.map((resource) =>
      resource.state === "DELETE_REQUESTED"
        ? ("gone" as const)
        : ("found" as const),
    ),
    Effect.catchTag(["NotFound", "Forbidden"], () =>
      Effect.succeed("gone" as const),
    ),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

const resolveParent = Effect.gen(function* () {
  const resource = yield* resourcemanager.getProjects({
    name: `projects/${project}`,
  });
  return resource.parent;
});

test.provider.skipIf(!hasGcpCreds)(
  "getProjects on a missing project fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        resourcemanager.getProjects({
          name: "projects/alchemy-missing-proj",
        }),
      );
      expect(["NotFound", "Forbidden"]).toContain(error._tag);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(
  !hasGcpCreds || process.env.GCP_TEST_RESOURCE_MANAGER === "1",
)(
  "createProjects without project-creator IAM fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const parent = yield* resolveParent.pipe(
        Effect.catchTag(["NotFound", "Forbidden"], () =>
          Effect.succeed(undefined),
        ),
      );
      const error = yield* Effect.flip(
        resourcemanager.createProjects({
          body: {
            projectId: "alchemy-rm-probe-xxxx",
            parent: parent ?? "organizations/0",
            displayName: "Alchemy Probe",
          },
        }),
      );
      expect(["Forbidden", "NotFound", "BadRequest", "Conflict"]).toContain(
        error._tag,
      );

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!runLifecycle)(
  "create, update, and delete a project",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.ResourceManager.Project("Sandbox", {
            displayName: "Sandbox",
            labels: { env: "test" },
          });
        }),
      );

      expect(created.name).toMatch(/^projects\//);
      expect(created.projectId).toEqual(expect.any(String));
      expect(created.projectId.length).toBeGreaterThanOrEqual(6);
      expect(created.displayName).toEqual("Sandbox");
      expect(created.labels).toMatchObject({ env: "test" });
      expect(created.state).toEqual("ACTIVE");

      const fetched = yield* resourcemanager.getProjects({
        name: created.name,
      });
      expect(fetched.name).toEqual(created.name);
      expect(fetched.projectId).toEqual(created.projectId);
      expect(fetched.labels?.env).toEqual("test");
      expect(fetched.labels?.["alchemy-id"]).toEqual(expect.any(String));

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.ResourceManager.Project("Sandbox", {
            projectId: created.projectId,
            parent: created.parent,
            displayName: "Sandbox prod",
            labels: { env: "prod" },
          });
        }),
      );

      expect(updated.name).toEqual(created.name);
      expect(updated.projectId).toEqual(created.projectId);
      expect(updated.displayName).toEqual("Sandbox prod");
      expect(updated.labels).toMatchObject({ env: "prod" });
      expect(updated.createTime).toEqual(created.createTime);

      const fetchedUpdate = yield* resourcemanager.getProjects({
        name: updated.name,
      });
      expect(fetchedUpdate.displayName).toEqual("Sandbox prod");
      expect(fetchedUpdate.labels?.env).toEqual("prod");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(updated.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 90_000 },
);
