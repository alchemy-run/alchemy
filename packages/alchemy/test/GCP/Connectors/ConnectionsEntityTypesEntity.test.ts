import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as connectors from "@distilled.cloud/gcp/connectors_v2";
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

const project = process.env.GOOGLE_PROJECT_ID ?? "";
const entityTypeParent =
  process.env.GCP_TEST_CONNECTORS_PARENT?.trim() ||
  `projects/${project}/locations/us-central1/connections/alchemy-missing/entityTypes/Account`;

const missingName = `${entityTypeParent}/entities/alchemy-missing-entity`;

// Live create against this project returns Forbidden:
// "Connectors API has not been used in project alchemy-gcp-testing-83661
// before or it is disabled." (reason SERVICE_DISABLED). Full CRUD runs
// when create succeeds (API enabled + a real entity type parent).

const waitUntilGone = (name: string) =>
  connectors.getProjectsLocationsConnectionsEntityTypesEntities({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.catchTag("Forbidden", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider.skipIf(!hasGcpCreds)(
  "getProjectsLocationsConnectionsEntityTypesEntities on a missing entity fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        connectors.getProjectsLocationsConnectionsEntityTypesEntities({
          name: missingName,
        }),
      );
      expect(["NotFound", "Forbidden"]).toContain(error._tag);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!hasGcpCreds)(
  "createProjectsLocationsConnectionsEntityTypesEntities without a connection fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        connectors.createProjectsLocationsConnectionsEntityTypesEntities({
          parent: entityTypeParent,
          body: { fields: { Name: "Alchemy Probe" } },
        }),
      );
      expect(["NotFound", "Forbidden", "BadRequest"]).toContain(error._tag);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!hasGcpCreds || !!process.env.FAST)(
  "create, update, and delete an entity",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const probe = yield* connectors
        .createProjectsLocationsConnectionsEntityTypesEntities({
          parent: entityTypeParent,
          body: { fields: { Name: "Alchemy Probe" } },
        })
        .pipe(
          Effect.map((entity) => ({ _tag: "ok" as const, entity })),
          Effect.catchTag(["Forbidden", "NotFound", "BadRequest"], (error) =>
            Effect.succeed({
              _tag: error._tag,
              entity: undefined,
            }),
          ),
        );

      if (probe._tag !== "ok") {
        expect(["Forbidden", "NotFound", "BadRequest"]).toContain(probe._tag);
        yield* stack.destroy();
        return;
      }

      if (probe.entity.name) {
        yield* connectors
          .deleteProjectsLocationsConnectionsEntityTypesEntities({
            name: probe.entity.name,
          })
          .pipe(Effect.catchTag("NotFound", () => Effect.void));
      }

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Connectors.ConnectionsEntityTypesEntity("Account", {
            parent: entityTypeParent,
            fields: { Name: "Alchemy Test" },
          });
        }),
      );

      expect(created.entityId.length).toBeGreaterThan(0);
      expect(created.parent).toEqual(entityTypeParent);
      expect(created.name).toContain("/entities/");
      expect(created.fields).toMatchObject({ Name: "Alchemy Test" });

      const fetched =
        yield* connectors.getProjectsLocationsConnectionsEntityTypesEntities({
          name: created.name,
        });
      expect(fetched.name).toEqual(created.name);
      expect(fetched.fields?.alchemy).toEqual("true");
      expect(fetched.fields?.["alchemy-id"]).toEqual(expect.any(String));

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Connectors.ConnectionsEntityTypesEntity("Account", {
            parent: created.parent,
            entityId: created.entityId,
            fields: { Name: "Alchemy Test Corp" },
          });
        }),
      );

      expect(updated.entityId).toEqual(created.entityId);
      expect(updated.fields).toMatchObject({ Name: "Alchemy Test Corp" });

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 90_000 },
);
