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
  logging.getOrganizationsLocationsSavedQueries({ name }).pipe(
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
  "getOrganizationsLocationsSavedQueries on a missing query fails with NotFound or Forbidden",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const organization = (yield* organizationOf()) || "organizations/0";
      const error = yield* Effect.flip(
        logging.getOrganizationsLocationsSavedQueries({
          name: `${organization}/locations/global/savedQueries/alchemy-missing`,
        }),
      );
      expect(["NotFound", "Forbidden"]).toContain(error._tag);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!hasGcpCreds)(
  "create, update, replace, and delete an organization logging saved query",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const organization = yield* organizationOf();
      if (organization.length === 0) {
        const error = yield* Effect.flip(
          logging.createOrganizationsLocationsSavedQueries({
            parent: "organizations/0/locations/global",
            savedQueryId: "alchemy-probe",
            body: {
              displayName: "probe",
              visibility: "PRIVATE",
              loggingQuery: { filter: "severity>=ERROR" },
            },
          }),
        );
        expect(["NotFound", "Forbidden", "BadRequest"]).toContain(error._tag);
        yield* stack.destroy();
        return;
      }

      const access = yield* logging
        .listOrganizationsLocationsSavedQueries({
          parent: `${organization}/locations/-`,
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
          return yield* GCP.Logging.OrganizationSavedQuery("Errors", {
            organization,
            displayName: "organization errors",
            loggingQuery: { filter: "severity>=ERROR" },
            description: "error query",
          });
        }),
      );

      expect(created.savedQueryId).toEqual(expect.any(String));
      expect(created.location).toEqual("global");
      expect(created.organization).toEqual(organization);
      expect(created.name).toEqual(
        `${organization}/locations/global/savedQueries/${created.savedQueryId}`,
      );
      expect(created.displayName).toEqual("organization errors");
      expect(created.loggingQuery?.filter).toEqual("severity>=ERROR");
      expect(created.description).toEqual("error query");

      const fetched = yield* logging.getOrganizationsLocationsSavedQueries({
        name: created.name,
      });
      expect(fetched.displayName).toEqual("organization errors");
      expect(fetched.description).toContain("alchemy-id=");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Logging.OrganizationSavedQuery("Errors", {
            organization,
            savedQueryId: created.savedQueryId,
            displayName: "organization warnings",
            loggingQuery: { filter: "severity>=WARNING" },
            description: "warning query",
          });
        }),
      );

      expect(updated.name).toEqual(created.name);
      expect(updated.displayName).toEqual("organization warnings");
      expect(updated.loggingQuery?.filter).toEqual("severity>=WARNING");

      const last = created.savedQueryId.at(-1) ?? "a";
      const nextId = `${created.savedQueryId.slice(0, -1)}${last === "z" ? "0" : "z"}`;

      const replaced = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Logging.OrganizationSavedQuery("Errors", {
            organization,
            savedQueryId: nextId,
            displayName: "replaced query",
            loggingQuery: { filter: "severity>=ERROR" },
            description: "replaced query",
          });
        }),
      );

      expect(replaced.savedQueryId).not.toEqual(created.savedQueryId);

      const previousGone = yield* waitUntilGone(created.name);
      expect(previousGone).toEqual("gone");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(replaced.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 90_000 },
);
