import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as logging from "@distilled.cloud/gcp/logging_v2";
import * as resourcemanager from "@distilled.cloud/gcp/cloudresourcemanager_v3";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import { GcpEnvironment } from "@/GCP/Environment";

const { test } = Test.make({ providers: GCP.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);
const projectNameOf = (project: string) => `projects/${project}`;

const waitUntilGone = (name: string) =>
  logging.getOrganizationsLocationsLogScopes({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

const organizationOf = () =>
  Effect.gen(function* () {
    const { project } = yield* GcpEnvironment.current;

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

test.provider(
  "getOrganizationsLocationsLogScopes on a missing log scope fails with NotFound or Forbidden",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const organization = (yield* organizationOf()) || "organizations/0";
      const error = yield* Effect.flip(
        logging.getOrganizationsLocationsLogScopes({
          name: `${organization}/locations/global/logScopes/alchemy-missing`,
        }),
      );
      expect(["NotFound", "Forbidden"]).toContain(error._tag);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider(
  "create, update, replace, and delete an organization logging log scope",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;

      yield* stack.destroy();

      const organization = yield* organizationOf();
      if (organization.length === 0) {
        const error = yield* Effect.flip(
          logging.createOrganizationsLocationsLogScopes({
            parent: "organizations/0/locations/global",
            logScopeId: "alchemy-probe",
            body: { resourceNames: [projectNameOf(project)] },
          }),
        );
        expect(["NotFound", "Forbidden", "BadRequest"]).toContain(error._tag);
        yield* stack.destroy();
        return;
      }

      const access = yield* logging
        .listOrganizationsLocationsLogScopes({
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
        expect(["Forbidden", "NotFound"]).toContain(access);
        yield* stack.destroy();
        return;
      }

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Logging.OrganizationLogScope("App", {
            organization,
            resourceNames: [projectNameOf(project)],
            description: "application logs",
          });
        }),
      );

      expect(created.logScopeId).toEqual(expect.any(String));
      expect(created.location).toEqual("global");
      expect(created.organization).toEqual(organization);
      expect(created.name).toEqual(
        `${organization}/locations/global/logScopes/${created.logScopeId}`,
      );
      expect(created.resourceNames).toEqual([projectNameOf(project)]);
      expect(created.description).toEqual("application logs");

      const fetched = yield* logging.getOrganizationsLocationsLogScopes({
        name: created.name,
      });
      expect(fetched.resourceNames).toEqual([projectNameOf(project)]);
      expect(fetched.description).toContain("alchemy-id=");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Logging.OrganizationLogScope("App", {
            organization,
            logScopeId: created.logScopeId,
            resourceNames: [projectNameOf(project)],
            description: "updated application logs",
          });
        }),
      );

      expect(updated.name).toEqual(created.name);
      expect(updated.description).toEqual("updated application logs");

      const last = created.logScopeId.at(-1) ?? "a";
      const nextId = `${created.logScopeId.slice(0, -1)}${last === "z" ? "0" : "z"}`;

      const replaced = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Logging.OrganizationLogScope("App", {
            organization,
            logScopeId: nextId,
            resourceNames: [projectNameOf(project)],
            description: "replaced scope",
          });
        }),
      );

      expect(replaced.logScopeId).not.toEqual(created.logScopeId);

      const previousGone = yield* waitUntilGone(created.name);
      expect(previousGone).toEqual("gone");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(replaced.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 90_000 },
);
