import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as logging from "@distilled.cloud/gcp/logging_v2";
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

const project = process.env.GOOGLE_PROJECT_ID ?? "";

const waitUntilGone = (name: string) =>
  logging.getOrganizationsExclusions({ name }).pipe(
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
  "getOrganizationsExclusions on a missing exclusion fails with NotFound or Forbidden",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const organization = (yield* organizationOf()) || "organizations/0";
      const error = yield* Effect.flip(
        logging.getOrganizationsExclusions({
          name: `${organization}/exclusions/alchemy-missing`,
        }),
      );
      expect(["NotFound", "Forbidden"]).toContain(error._tag);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!hasGcpCreds)(
  "create, update, replace, and delete an organization exclusion",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const organization = yield* organizationOf();
      if (organization.length === 0) {
        const error = yield* Effect.flip(
          logging.createOrganizationsExclusions({
            parent: "organizations/0",
            body: { name: "alchemy-probe", filter: "severity=DEBUG" },
          }),
        );
        expect(["NotFound", "Forbidden", "BadRequest"]).toContain(error._tag);
        yield* stack.destroy();
        return;
      }

      const access = yield* logging
        .listOrganizationsExclusions({
          parent: organization,
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
          return yield* GCP.Logging.OrganizationExclusion("DropDebug", {
            organization,
            filter: "severity=DEBUG",
            description: "drop debug entries",
          });
        }),
      );

      expect(created.exclusionId).toEqual(expect.any(String));
      expect(created.organization).toEqual(organization);
      expect(created.name).toEqual(
        `${organization}/exclusions/${created.exclusionId}`,
      );
      expect(created.filter).toEqual("severity=DEBUG");
      expect(created.description).toEqual("drop debug entries");

      const fetched = yield* logging.getOrganizationsExclusions({
        name: created.name,
      });
      expect(fetched.filter).toEqual("severity=DEBUG");
      expect(fetched.description).toContain("alchemy-id=");
      expect(fetched.description).toContain("drop debug entries");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Logging.OrganizationExclusion("DropDebug", {
            organization,
            exclusionId: created.exclusionId,
            filter: "severity<ERROR",
            description: "drop non-errors",
            disabled: true,
          });
        }),
      );

      expect(updated.filter).toEqual("severity<ERROR");
      expect(updated.disabled).toEqual(true);

      const last = created.exclusionId.at(-1) ?? "a";
      const nextExclusionId = `${created.exclusionId.slice(0, -1)}${last === "z" ? "0" : "z"}`;

      const replaced = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Logging.OrganizationExclusion("DropDebug", {
            organization,
            exclusionId: nextExclusionId,
            filter: "severity=DEBUG",
            description: "replaced exclusion",
          });
        }),
      );

      expect(replaced.exclusionId).not.toEqual(created.exclusionId);

      const previousGone = yield* waitUntilGone(created.name);
      expect(previousGone).toEqual("gone");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(replaced.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 90_000 },
);
