import { Action } from "@/Action";
import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as connectors from "@distilled.cloud/gcp/connectors_v2";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";

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

test.provider.skipIf(!hasGcpCreds || !!process.env.FAST)(
  "GetEntity round-trip",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const probe = yield* connectors
        .createProjectsLocationsConnectionsEntityTypesEntities({
          parent: entityTypeParent,
          body: { fields: { Name: "Alchemy Binding Probe" } },
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

      const out = yield* stack.deploy(
        Effect.gen(function* () {
          const account = yield* GCP.Connectors.ConnectionsEntityTypesEntity(
            "Account",
            {
              parent: entityTypeParent,
              fields: { Name: "Alchemy Binding" },
            },
          );
          const Probe = Action(
            "Probe",
            Effect.gen(function* () {
              const getEntity = yield* GCP.Connectors.GetEntity(account);
              return Effect.fn(function* () {
                const live = yield* getEntity();
                return { name: live.name, fields: live.fields };
              });
            }),
          );
          return yield* Probe({});
        }),
      );

      expect(out.name).toContain("/entities/");
      expect(out.fields).toMatchObject({ Name: "Alchemy Binding" });

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);
