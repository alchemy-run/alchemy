import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as resourcemanager from "@distilled.cloud/gcp/cloudresourcemanager_v3";
import * as osconfig from "@distilled.cloud/gcp/osconfig_v2";
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

const waitUntilGone = (name: string) =>
  osconfig.getOrganizationsLocationsGlobalPolicyOrchestrators({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag(["NotFound", "Forbidden"], () =>
      Effect.succeed("gone" as const),
    ),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

const organizationOf = () =>
  Effect.gen(function* () {
    const fromEnv = process.env.GOOGLE_ORGANIZATION_ID;
    if (fromEnv && fromEnv.length > 0) {
      return fromEnv.startsWith("organizations/")
        ? fromEnv
        : `organizations/${fromEnv}`;
    }
    let current: string | undefined = `projects/${project}`;
    for (let i = 0; i < 8; i++) {
      if (current === undefined) return "";
      if (current.startsWith("organizations/")) return current;
      current = current.startsWith("projects/")
        ? yield* resourcemanager.getProjects({ name: current }).pipe(
            Effect.map((resource) => resource.parent),
            Effect.catchTag(["NotFound", "Forbidden"], () =>
              Effect.succeed(undefined),
            ),
          )
        : current.startsWith("folders/")
          ? yield* resourcemanager.getFolders({ name: current }).pipe(
              Effect.map((folder) => folder.parent),
              Effect.catchTag(["NotFound", "Forbidden"], () =>
                Effect.succeed(undefined),
              ),
            )
          : undefined;
    }
    return "";
  });

test.provider.skipIf(!hasGcpCreds)(
  "getOrganizationsLocationsGlobalPolicyOrchestrators on a missing orchestrator fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const organization = (yield* organizationOf()) || "organizations/0";
      const error = yield* Effect.flip(
        osconfig.getOrganizationsLocationsGlobalPolicyOrchestrators({
          name: `${organization}/locations/global/policyOrchestrators/alchemy-missing-orch`,
        }),
      );
      expect(["NotFound", "Forbidden", "BadRequest"]).toContain(error._tag);
      if (error._tag === "Forbidden") {
        expect(error.message).toContain("OS Config API has not been used");
      }

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!hasGcpCreds)(
  "create, update, and delete an organization policy orchestrator",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const organization = yield* organizationOf();
      if (organization.length === 0) {
        const error = yield* Effect.flip(
          osconfig.createOrganizationsLocationsGlobalPolicyOrchestrators({
            parent: "organizations/0/locations/global",
            policyOrchestratorId: "alchemy-probe",
            body: { action: "UPSERT", state: "STOPPED" },
          }),
        );
        expect(["NotFound", "Forbidden", "BadRequest"]).toContain(error._tag);
        if (error._tag === "Forbidden") {
          expect(error.message).toContain("OS Config API has not been used");
        }
        yield* stack.destroy();
        return;
      }

      const access = yield* osconfig
        .listOrganizationsLocationsGlobalPolicyOrchestrators({
          parent: `${organization}/locations/global`,
          pageSize: 1,
        })
        .pipe(
          Effect.as("ok" as const),
          Effect.catchTag(["Forbidden", "NotFound"], (error) =>
            Effect.succeed(error._tag),
          ),
        );
      if (access !== "ok") {
        expect(access).toEqual("Forbidden");
        const listed = yield* Effect.flip(
          osconfig.listOrganizationsLocationsGlobalPolicyOrchestrators({
            parent: `${organization}/locations/global`,
            pageSize: 1,
          }),
        );
        expect(listed._tag).toEqual("Forbidden");
        if (listed._tag === "Forbidden") {
          expect(listed.message).toContain("OS Config API has not been used");
        }
        yield* stack.destroy();
        return;
      }

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Osconfig.OrganizationsLocationsGlobalPolicyOrchestrator(
            "Debian",
            {
              organizationId: organization,
              description: "org validation",
              labels: { env: "test" },
              state: "STOPPED",
            },
          );
        }),
      );

      expect(created.policyOrchestratorId).toEqual(expect.any(String));
      expect(created.organizationId).toEqual(
        organization.replace("organizations/", ""),
      );
      expect(created.parent).toEqual(`${organization}/locations/global`);
      expect(created.name).toEqual(
        `${organization}/locations/global/policyOrchestrators/${created.policyOrchestratorId}`,
      );
      expect(created.state).toEqual("STOPPED");
      expect(created.labels).toMatchObject({ env: "test" });

      const fetched =
        yield* osconfig.getOrganizationsLocationsGlobalPolicyOrchestrators({
          name: created.name,
        });
      expect(fetched.name).toEqual(created.name);
      expect(fetched.labels?.env).toEqual("test");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Osconfig.OrganizationsLocationsGlobalPolicyOrchestrator(
            "Debian",
            {
              organizationId: organization,
              policyOrchestratorId: created.policyOrchestratorId,
              description: "updated org",
              labels: { env: "prod" },
              state: "STOPPED",
            },
          );
        }),
      );

      expect(updated.name).toEqual(created.name);
      expect(updated.description).toEqual("updated org");
      expect(updated.labels).toMatchObject({ env: "prod" });

      yield* stack.destroy();
      const gone = yield* waitUntilGone(created.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 90_000 },
);
