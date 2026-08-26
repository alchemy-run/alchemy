import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as essentialcontacts from "@distilled.cloud/gcp/essentialcontacts_v1";
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
  essentialcontacts.getOrganizationsContacts({ name }).pipe(
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
  "getOrganizationsContacts on a missing contact fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const organization = (yield* organizationOf()) || "organizations/0";
      const error = yield* Effect.flip(
        essentialcontacts.getOrganizationsContacts({
          name: `${organization}/contacts/0`,
        }),
      );
      expect(["NotFound", "Forbidden", "BadRequest"]).toContain(error._tag);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!hasGcpCreds)(
  "create, update, replace, and delete an organization essential contact",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const organization = yield* organizationOf();
      if (organization.length === 0) {
        const error = yield* Effect.flip(
          essentialcontacts.createOrganizationsContacts({
            parent: "organizations/0",
            body: {
              email: "ops@example.com",
              languageTag: "en-US",
              notificationCategorySubscriptions: ["ALL"],
            },
          }),
        );
        expect(["NotFound", "Forbidden", "BadRequest"]).toContain(error._tag);
        yield* stack.destroy();
        return;
      }

      const access = yield* essentialcontacts
        .listOrganizationsContacts({ parent: organization, pageSize: 1 })
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
          return yield* GCP.Essentialcontacts.OrganizationContact("Ops", {
            organization,
            email: "org-ops@example.com",
            languageTag: "en-US",
            notificationCategorySubscriptions: ["ALL"],
          });
        }),
      );

      expect(created.contactId.length).toBeGreaterThan(0);
      expect(created.organization).toEqual(organization);
      expect(created.email).toEqual("org-ops@example.com");
      expect(created.languageTag).toEqual("en-US");

      const fetched = yield* essentialcontacts.getOrganizationsContacts({
        name: created.name,
      });
      expect(fetched.name).toEqual(created.name);
      expect(fetched.email).toContain("+alc.");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Essentialcontacts.OrganizationContact("Ops", {
            organization,
            email: "org-ops@example.com",
            languageTag: "en-GB",
            notificationCategorySubscriptions: ["LEGAL"],
          });
        }),
      );

      expect(updated.name).toEqual(created.name);
      expect(updated.languageTag).toEqual("en-GB");
      expect(updated.notificationCategorySubscriptions).toEqual(["LEGAL"]);

      const replaced = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Essentialcontacts.OrganizationContact("Ops", {
            organization,
            email: "org-sec@example.com",
            languageTag: "en-GB",
            notificationCategorySubscriptions: ["SECURITY"],
          });
        }),
      );

      expect(replaced.email).toEqual("org-sec@example.com");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(replaced.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 90_000 },
);
