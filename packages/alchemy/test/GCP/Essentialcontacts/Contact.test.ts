import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as essentialcontacts from "@distilled.cloud/gcp/essentialcontacts_v1";
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
  essentialcontacts.getProjectsContacts({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider.skipIf(!hasGcpCreds)(
  "getProjectsContacts on a missing contact fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        essentialcontacts.getProjectsContacts({
          name: `projects/${project}/contacts/0`,
        }),
      );
      expect(["NotFound", "Forbidden", "BadRequest"]).toContain(error._tag);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!hasGcpCreds)(
  "create, update, replace, and delete a project essential contact",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const access = yield* essentialcontacts
        .listProjectsContacts({
          parent: `projects/${project}`,
          pageSize: 1,
        })
        .pipe(
          Effect.as("ok" as const),
          Effect.catchTag("Forbidden", (error) => Effect.succeed(error._tag)),
        );
      if (access !== "ok") {
        expect(access).toEqual("Forbidden");
        yield* stack.destroy();
        return;
      }

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Essentialcontacts.Contact("Ops", {
            email: "ops@example.com",
            languageTag: "en-US",
            notificationCategorySubscriptions: ["ALL"],
          });
        }),
      );

      expect(created.contactId.length).toBeGreaterThan(0);
      expect(created.name).toContain("/contacts/");
      expect(created.email).toEqual("ops@example.com");
      expect(created.languageTag).toEqual("en-US");
      expect(created.notificationCategorySubscriptions).toEqual(["ALL"]);
      expect(created.project).toEqual(project);

      const fetched = yield* essentialcontacts.getProjectsContacts({
        name: created.name,
      });
      expect(fetched.name).toEqual(created.name);
      expect(fetched.email).toContain("+alc.");
      expect(fetched.email).toContain("ops@");
      expect(fetched.languageTag).toEqual("en-US");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Essentialcontacts.Contact("Ops", {
            email: "ops@example.com",
            languageTag: "en-GB",
            notificationCategorySubscriptions: ["SECURITY", "TECHNICAL"],
          });
        }),
      );

      expect(updated.name).toEqual(created.name);
      expect(updated.email).toEqual("ops@example.com");
      expect(updated.languageTag).toEqual("en-GB");
      expect(updated.notificationCategorySubscriptions).toEqual([
        "SECURITY",
        "TECHNICAL",
      ]);

      const replaced = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Essentialcontacts.Contact("Ops", {
            email: "security@example.com",
            languageTag: "en-GB",
            notificationCategorySubscriptions: ["SECURITY"],
          });
        }),
      );

      expect(replaced.email).toEqual("security@example.com");
      expect(replaced.contactId.length).toBeGreaterThan(0);
      expect(replaced.languageTag).toEqual("en-GB");
      expect(replaced.notificationCategorySubscriptions).toEqual(["SECURITY"]);

      yield* stack.destroy();

      const gone = yield* waitUntilGone(replaced.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 90_000 },
);
