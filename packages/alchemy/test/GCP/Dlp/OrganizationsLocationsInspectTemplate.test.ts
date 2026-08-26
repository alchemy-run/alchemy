import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as dlp from "@distilled.cloud/gcp/dlp_v2";
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
const location = "us-central1";

const waitUntilGone = (name: string) =>
  dlp.getOrganizationsLocationsInspectTemplates({ name }).pipe(
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
  "getOrganizationsLocationsInspectTemplates on a missing template fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const organization = (yield* organizationOf()) || "organizations/0";
      const error = yield* Effect.flip(
        dlp.getOrganizationsLocationsInspectTemplates({
          name: `${organization}/locations/${location}/inspectTemplates/alchemy-missing`,
        }),
      );
      expect(["NotFound", "Forbidden"]).toContain(error._tag);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!hasGcpCreds)(
  "create, update, and delete a location-scoped organization inspect template",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const organization = yield* organizationOf();
      if (organization.length === 0) {
        const error = yield* Effect.flip(
          dlp.createOrganizationsLocationsInspectTemplates({
            parent: `organizations/0/locations/${location}`,
            body: {
              templateId: "alchemy-probe",
              inspectTemplate: {
                inspectConfig: { infoTypes: [{ name: "PHONE_NUMBER" }] },
              },
            },
          }),
        );
        expect(["NotFound", "Forbidden", "BadRequest"]).toContain(error._tag);
        yield* stack.destroy();
        return;
      }

      const parent = `${organization}/locations/${location}`;
      const access = yield* dlp
        .listOrganizationsLocationsInspectTemplates({
          parent,
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
          return yield* GCP.Dlp.OrganizationsLocationsInspectTemplate(
            "Phones",
            {
              organization,
              location,
              displayName: "phones",
              description: "detect phones",
              inspectConfig: {
                infoTypes: [{ name: "PHONE_NUMBER" }],
                includeQuote: true,
              },
            },
          );
        }),
      );

      expect(created.location).toEqual(location);
      expect(created.name).toEqual(
        `${parent}/inspectTemplates/${created.templateId}`,
      );

      const fetched = yield* dlp.getOrganizationsLocationsInspectTemplates({
        name: created.name,
      });
      expect(fetched.description).toContain("alchemy-id=");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Dlp.OrganizationsLocationsInspectTemplate(
            "Phones",
            {
              organization,
              location,
              templateId: created.templateId,
              displayName: "phones-v2",
              description: "detect phones v2",
              inspectConfig: {
                infoTypes: [{ name: "PHONE_NUMBER" }],
                includeQuote: false,
              },
            },
          );
        }),
      );

      expect(updated.name).toEqual(created.name);
      expect(updated.displayName).toEqual("phones-v2");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 90_000 },
);
